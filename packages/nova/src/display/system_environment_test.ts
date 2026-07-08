import "jasmine";
import { getIntegrationGameData } from "../communication/simulation_test_fixture.js";
import { effectiveMurk, MurkState } from "./system_environment_plugin.js";

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
