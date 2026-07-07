import "jasmine";
import { PersResource } from "../../src/resource_parsers/pers_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A përs resource with every field set to a distinct, recognizable value. */
function buildPers(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(10001)                          // linkSystem
        .int16(200)                         // govt
        .int16(3)                           // aiType
        .int16(2)                           // aggression
        .int16(25)                          // cowardice
        .int16(150)                         // shipType
        .array([300, 301, -1, 302], v => b.int16(v))  // weapon ids
        .array([1, 2, 3, 4], v => b.int16(v))         // counts
        .array([50, 60, 70, 80], v => b.int16(v))     // ammo
        .int32(50000)                       // credits
        .int16(130)                         // shieldMod
        .int16(4001)                        // hailPict
        .int16(15)                          // commQuote
        .int16(27)                          // hailQuote
        .int16(400)                         // linkMission
        .uint16(0x8043)                     // flags
        .string("b128 !b200", 256)          // activeOn
        .int16(5)                           // grantClass
        .int16(3)                           // grantCount
        .int16(75)                          // grantChance
        .string("the Rebel Hero", 64)       // subtitle
        .uint32(0x00ff8800)                 // color
        .uint16(0x0001)                     // flags2
        .skip(16);                          // unused
    return b;
}

describe("PersResource", () => {
    // Pers resources don't depend on other resources for parsing.
    const idSpace = defaultIDSpace;

    let pers: PersResource;

    beforeEach(() => {
        pers = new PersResource(
            buildPers().resource("përs", 128, "Rebel Hero"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 400 bytes is the size of every përs in Nova's own data files.
        expect(buildPers().byteLength).toBe(400);
    });

    it("parses character traits", () => {
        expect(pers.linkSystem).toBe(10001);
        expect(pers.govt).toBe(200);
        expect(pers.aiType).toBe(3);
        expect(pers.aggression).toBe(2);
        expect(pers.cowardice).toBe(25);
    });

    it("parses shipType and zips weapons, dropping empty entries", () => {
        expect(pers.shipType).toBe(150);
        expect(pers.weapons).toEqual([
            { id: 300, count: 1, ammo: 50 },
            { id: 301, count: 2, ammo: 60 },
            { id: 302, count: 4, ammo: 80 },
        ]);
    });

    it("parses credits and shieldMod", () => {
        expect(pers.credits).toBe(50000);
        expect(pers.shieldMod).toBe(130);
    });

    it("parses quote and mission ids", () => {
        expect(pers.hailPict).toBe(4001);
        expect(pers.commQuote).toBe(15);
        expect(pers.hailQuote).toBe(27);
        expect(pers.linkMission).toBe(400);
    });

    it("parses flags", () => {
        expect(pers.flags).toBe(0x8043);
        expect(pers.keepsGrudge).toBe(true);
        expect(pers.usesEscapePodAndAfterburner).toBe(true);
        expect(pers.hailOnlyWithGrudge).toBe(false);
        expect(pers.hailOnlyWhenAttacking).toBe(false);
        expect(pers.replaceWithSpecialShip).toBe(true);
        expect(pers.showDisasterInfoWhenHailing).toBe(true);
        expect(pers.noMissionIfWarship).toBe(false);
    });

    it("parses activeOn as a raw string", () => {
        expect(pers.activeOn).toBe("b128 !b200");
    });

    it("parses outfit-grant fields", () => {
        expect(pers.grantClass).toBe(5);
        expect(pers.grantCount).toBe(3);
        expect(pers.grantChance).toBe(75);
    });

    it("parses subtitle and color", () => {
        expect(pers.subtitle).toBe("the Rebel Hero");
        expect(pers.color).toBe(0x00ff8800);
    });

    it("parses flags2", () => {
        expect(pers.flags2).toBe(0x0001);
        expect(pers.startsWithNoFuel).toBe(true);
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off immediately after shieldMod (offset 42).
        const truncated = buildPers().truncate(42);
        const pers = new PersResource(
            truncated.resource("përs", 129, "Truncated"), idSpace);
        expect(pers.shieldMod).toBe(130);
        expect(pers.hailPict).toBe(-1);
        expect(pers.linkMission).toBe(-1);
        expect(pers.flags).toBe(0);
        expect(pers.keepsGrudge).toBe(false);
        expect(pers.activeOn).toBe("");
        expect(pers.subtitle).toBe("");
        expect(pers.color).toBe(0);
        expect(pers.startsWithNoFuel).toBe(false);
    });
});
