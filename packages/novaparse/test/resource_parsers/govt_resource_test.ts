import "jasmine";
import { GovtResource } from "../../src/resource_parsers/govt_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A gövt resource with every field set to a distinct, recognizable value. */
function buildGovt(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(1003)                           // voiceType
        .uint16(0x0243)                     // flags
        .uint16(0x0091)                     // flags2
        .int16(-5)                          // scanFine
        .int16(200)                         // crimeTol
        .int16(15)                          // smugPenalty
        .int16(30)                          // disabPenalty
        .int16(45)                          // boardPenalty
        .int16(60)                          // killPenalty
        .int16(5)                           // shootPenalty
        .int16(-20)                         // initialRec
        .int16(300)                         // maxOdds
        .array([1, 2, -1, -1], v => b.int16(v))   // classes
        .array([3, -1, -1, -1], v => b.int16(v))  // allies
        .array([4, 5, 6, -1], v => b.int16(v))    // enemies
        .int16(150)                         // skillMult
        .uint16(0x8001)                     // scanMask
        .string("Vell-os", 16)              // commName
        .string("VL", 16)                   // targetCode
        .uint64(0x0000000100000002n)        // require
        .array([10, 20, 30, 40], v => b.int16(v)) // inhJam
        .string("the Vell-os", 64)          // mediumName
        .uint32(0x00ff8800)                 // color
        .uint32(0x00123456)                 // shipColor
        .int16(130)                         // interface
        .int16(9001)                        // newsPic
        .skip(16);                          // unused
    return b;
}

describe("GovtResource", () => {
    // Govts don't depend on other resources.
    const idSpace = defaultIDSpace;

    let govt: GovtResource;

    beforeEach(() => {
        govt = new GovtResource(
            buildGovt().resource("gövt", 128, "Vell-os"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 192 bytes is the size of every gövt in Nova's own data files.
        expect(buildGovt().byteLength).toBe(192);
    });

    it("parses voiceType", () => {
        expect(govt.voiceType).toBe(1003);
    });

    it("parses flags", () => {
        expect(govt.flags).toBe(0x0243);
        expect(govt.xenophobic).toBe(true);
        expect(govt.attacksPlayerIfCriminal).toBe(true);
        expect(govt.alwaysAttacksPlayer).toBe(false);
        expect(govt.playerShotsPassThrough).toBe(false);
        expect(govt.neverAttacksPlayer).toBe(true);
        expect(govt.warshipsTakeBribes).toBe(true);
        expect(govt.largerBribes).toBe(false);
    });

    it("parses flags2", () => {
        expect(govt.flags2).toBe(0x0091);
        expect(govt.noAssistOrMercy).toBe(true);
        expect(govt.minorMapBoundaries).toBe(false);
        expect(govt.roadsideAssistance).toBe(true);
        expect(govt.prefersWormholes).toBe(true);
    });

    it("parses legal-system fields", () => {
        expect(govt.scanFine).toBe(-5);
        expect(govt.crimeTol).toBe(200);
        expect(govt.smugPenalty).toBe(15);
        expect(govt.disabPenalty).toBe(30);
        expect(govt.boardPenalty).toBe(45);
        expect(govt.killPenalty).toBe(60);
        expect(govt.shootPenalty).toBe(5);
        expect(govt.initialRec).toBe(-20);
        expect(govt.maxOdds).toBe(300);
    });

    it("parses classes, allies, and enemies, dropping unused entries", () => {
        expect(govt.classes).toEqual([1, 2]);
        expect(govt.allies).toEqual([3]);
        expect(govt.enemies).toEqual([4, 5, 6]);
    });

    it("parses skillMult and scanMask", () => {
        expect(govt.skillMult).toBe(150);
        expect(govt.scanMask).toBe(0x8001);
    });

    it("parses strings", () => {
        expect(govt.commName).toBe("Vell-os");
        expect(govt.targetCode).toBe("VL");
        expect(govt.mediumName).toBe("the Vell-os");
    });

    it("parses require", () => {
        expect(govt.require).toBe(0x0000000100000002n);
    });

    it("parses inhJam", () => {
        expect(govt.inhJam).toEqual([10, 20, 30, 40]);
    });

    it("parses colors", () => {
        expect(govt.color).toBe(0x00ff8800);
        expect(govt.shipColor).toBe(0x00123456);
    });

    it("parses interface and newsPic", () => {
        expect(govt.interface).toBe(130);
        expect(govt.newsPic).toBe(9001);
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off immediately after maxOdds.
        const truncated = buildGovt().truncate(24);
        const govt = new GovtResource(
            truncated.resource("gövt", 129, "Truncated"), idSpace);
        expect(govt.maxOdds).toBe(300);
        expect(govt.classes).toEqual([]);
        expect(govt.commName).toBe("");
        expect(govt.require).toBe(0n);
        expect(govt.color).toBe(0);
    });
});
