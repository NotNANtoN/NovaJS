import "jasmine";
import { getIntegrationGameData } from "../communication/simulation_test_fixture.js";
import {
    effectiveMurk,
    FULL_MURK_VANISH_DISTANCE,
    murkAlpha,
    MurkState,
    starfieldMurkAlpha,
} from "./system_environment_plugin.js";

// These assertions run against the real Nova game data (Nova_Data), so they
// pin the sÿst murk/interference/background-colour fields end to end: sÿst
// resource -> SystResource parser -> SystemParse -> SystemData.
describe("system environment data", () => {
    it("plumbs murk, interference, and background color for a murky system", async () => {
        const gameData = await getIntegrationGameData();
        // nova:155 is a reference murky system in Nova's own data.
        const system = await gameData.data.System.get("nova:155");
        expect(system.murk).toBe(50);
        expect(system.interference).toBe(50);
        expect(system.backgroundColor).toBe(0x00191900);
    });

    it("leaves a normal system with no haze, static, or tint", async () => {
        const gameData = await getIntegrationGameData();
        const system = await gameData.data.System.get("nova:130");
        expect(system.murk).toBe(0);
        expect(system.interference).toBe(0);
        expect(system.backgroundColor).toBe(0);
    });

    it("parses the radar static ppat patterns from Nova Graphics 1", async () => {
        const gameData = await getIntegrationGameData();
        const ids = (await gameData.ids).PpatImage;
        // Nova Graphics 1 ships ten sensor-static patterns, ids 128-137.
        for (let id = 128; id <= 137; id++) {
            expect(ids).toContain(`nova:${id}`);
        }
        const png = await gameData.data.PpatImage.get("nova:128");
        const bytes = new Uint8Array(png);
        // PNG magic: 137 80 78 71.
        expect([...bytes.slice(0, 4)]).toEqual([137, 80, 78, 71]);
        expect(bytes.length).toBeGreaterThan(100);
    });
});

describe("effectiveMurk", () => {
    const base = (over: Partial<MurkState> = {}): MurkState =>
        ({ systemMurk: 0, murkReduction: 0, ...over });

    it("passes the system murk through with no reduction", () => {
        expect(effectiveMurk(base({ systemMurk: 60 }))).toBe(60);
    });

    it("subtracts an outfit murk reduction", () => {
        expect(effectiveMurk(base({ systemMurk: 60, murkReduction: 25 }))).toBe(35);
    });

    it("never drops below zero", () => {
        expect(effectiveMurk(base({ systemMurk: 20, murkReduction: 100 }))).toBe(0);
    });

    it("clamps above 100", () => {
        expect(effectiveMurk(base({ systemMurk: 150 }))).toBe(100);
    });
});

describe("murkAlpha", () => {
    const murk = (systemMurk: number, murkReduction = 0): MurkState =>
        ({ systemMurk, murkReduction });

    it("leaves everything fully visible with no murk", () => {
        expect(murkAlpha(0, murk(0))).toBe(1);
        expect(murkAlpha(1e6, murk(0))).toBe(1);
    });

    it("keeps the player's own ship (distance zero) fully visible", () => {
        expect(murkAlpha(0, murk(100))).toBe(1);
    });

    it("renders the nearer half of the vanishing range fully", () => {
        // At murk 100 the vanishing range is FULL_MURK_VANISH_DISTANCE.
        const vanish = FULL_MURK_VANISH_DISTANCE;
        expect(murkAlpha(vanish / 2, murk(100))).toBe(1);
    });

    it("fades linearly to zero across the outer half", () => {
        const vanish = FULL_MURK_VANISH_DISTANCE;
        expect(murkAlpha(vanish * 3 / 4, murk(100))).toBeCloseTo(0.5);
        expect(murkAlpha(vanish, murk(100))).toBe(0);
        expect(murkAlpha(vanish * 2, murk(100))).toBe(0);
    });

    it("scales the vanishing range inversely with murk", () => {
        // Murk 50 sees twice as far as murk 100.
        const vanish50 = FULL_MURK_VANISH_DISTANCE * 2;
        expect(murkAlpha(vanish50 / 2, murk(50))).toBe(1);
        expect(murkAlpha(vanish50, murk(50))).toBe(0);
        expect(murkAlpha(vanish50 * 3 / 4, murk(50))).toBeCloseTo(0.5);
    });

    it("extends visibility when an outfit reduces murk", () => {
        const distance = FULL_MURK_VANISH_DISTANCE * 1.5;
        // Invisible at murk 100, but visible with a 50-point reduction.
        expect(murkAlpha(distance, murk(100))).toBe(0);
        expect(murkAlpha(distance, murk(100, 50))).toBeGreaterThan(0);
    });
});

describe("starfieldMurkAlpha", () => {
    const murk = (systemMurk: number, murkReduction = 0): MurkState =>
        ({ systemMurk, murkReduction });

    it("leaves stars untouched with no murk", () => {
        expect(starfieldMurkAlpha(0, murk(0))).toBe(1);
        expect(starfieldMurkAlpha(0.5, murk(0))).toBe(1);
    });

    it("keeps stars visible past the murk even at full murk", () => {
        expect(starfieldMurkAlpha(0, murk(100))).toBeCloseTo(0.6);
        expect(starfieldMurkAlpha(0.5, murk(100))).toBeCloseTo(0.2);
    });

    it("dims stars with murk", () => {
        expect(starfieldMurkAlpha(0, murk(50))).toBeCloseTo(0.8);
    });

    it("fades deeper parallax layers more", () => {
        expect(starfieldMurkAlpha(0.5, murk(50)))
            .toBeLessThan(starfieldMurkAlpha(0, murk(50)));
    });

    it("brightens when an outfit reduces murk", () => {
        expect(starfieldMurkAlpha(0, murk(50, 25)))
            .toBeGreaterThan(starfieldMurkAlpha(0, murk(50)));
    });
});
