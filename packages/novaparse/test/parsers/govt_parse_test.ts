import "jasmine";
import { GovtResource } from "../../src/resource_parsers/govt_resource.js";
import { GovtParse } from "../../src/parsers/govt_parse.js";
import { StrNResource } from "../../src/resource_parsers/strn_resource.js";
import { getEmptyNovaResources, NovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { defaultIDSpace } from "../resource_parsers/default_id_space.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/**
 * A gövt resource with every field set to a distinct, recognizable value.
 * Mirrors the byte layout exercised in govt_resource_test.ts so this test
 * focuses on the projection onto the data-interface GovtData shape.
 */
function buildGovt(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(1003)                             // voiceType
        .uint16(0x0243)                       // flags
        .uint16(0x0091)                       // flags2
        .int16(-5)                            // scanFine
        .int16(200)                           // crimeTol
        .int16(15)                            // smugPenalty
        .int16(30)                            // disabPenalty
        .int16(45)                            // boardPenalty
        .int16(60)                            // killPenalty
        .int16(5)                             // shootPenalty
        .int16(-20)                           // initialRec
        .int16(300)                           // maxOdds
        .array([1, 2, -1, -1], v => b.int16(v))   // classes
        .array([3, -1, -1, -1], v => b.int16(v))  // allies
        .array([4, 5, 6, -1], v => b.int16(v))    // enemies
        .int16(150)                           // skillMult
        .uint16(0x8001)                       // scanMask
        .string("Vell-os", 16)                // commName
        .string("VL", 16)                     // targetCode
        .uint64(0x0000000100000002n)          // require
        .array([10, 20, 30, 40], v => b.int16(v)) // inhJam
        .string("the Vell-os", 64)            // mediumName
        .uint32(0x00ff8800)                   // color
        .uint32(0x00123456)                   // shipColor
        .int16(130)                           // interface
        .int16(9001)                          // newsPic
        .skip(16);                            // unused
    return b;
}

function parseGovt() {
    const resource = new GovtResource(
        buildGovt().resource("gövt", 128, "Vell-os"), defaultIDSpace);
    // IDSpaceHandler sets these in the real pipeline; BaseParse requires them.
    resource.globalID = "nova:128";
    resource.prefix = "nova";
    return GovtParse(resource, () => { });
}

/** Builds a STR# resource holding the given strings. */
function makeStrN(idSpace: NovaResources, id: number, strings: string[]) {
    const b = new ResourceBuilder();
    b.uint16(strings.length);
    for (const s of strings) {
        b.pstring(s);
    }
    idSpace["STR#"][id] = new StrNResource(
        b.resource("STR#", id, `strings ${id}`), idSpace);
}

/**
 * Parses a gövt of the given local id against a FRESH id space (the shared
 * defaultIDSpace is module-global; greeting fixtures must not leak into the
 * other suites), optionally seeded with one STR# resource.
 */
function parseGovtWithGreetings(govtId: number,
    strn?: { id: number, strings: string[] }) {
    const idSpace = getEmptyNovaResources();
    if (strn) {
        makeStrN(idSpace, strn.id, strn.strings);
    }
    const resource = new GovtResource(
        buildGovt().resource("gövt", govtId, "Vell-os"), idSpace);
    resource.globalID = `nova:${govtId}`;
    resource.prefix = "nova";
    return GovtParse(resource, () => { });
}

describe("GovtParse comm greetings (STR# 7000 + govt offset)", () => {
    it("reads the greetings of the first government from STR# 7000",
        async () => {
            const govt = await parseGovtWithGreetings(128,
                { id: 7000, strings: ["Greetings, pilot.", "State your business."] });
            expect(govt.commGreetings)
                .toEqual(["Greetings, pilot.", "State your business."]);
        });

    it("offsets the STR# id by the government's local id (gövt 130 -> 7002)",
        async () => {
            const govt = await parseGovtWithGreetings(130,
                { id: 7002, strings: ["We are the Vell-os."] });
            expect(govt.commGreetings).toEqual(["We are the Vell-os."]);
        });

    it("ignores a STR# at the wrong offset for this government", async () => {
        // 7000 belongs to gövt 128, not to gövt 130.
        const govt = await parseGovtWithGreetings(130,
            { id: 7000, strings: ["Wrong government."] });
        expect(govt.commGreetings).toEqual([]);
    });

    it("filters blank and \"*\" placeholder entries", async () => {
        const govt = await parseGovtWithGreetings(128, {
            id: 7000,
            strings: ["Hello.", "", "*", "   ", " * ", "Goodbye."],
        });
        expect(govt.commGreetings).toEqual(["Hello.", "Goodbye."]);
    });

    it("resolves to an empty list when the government has no STR#",
        async () => {
            const govt = await parseGovtWithGreetings(128);
            expect(govt.commGreetings).toEqual([]);
        });
});

describe("GovtParse", () => {
    it("carries the BaseData fields", async () => {
        const govt = await parseGovt();
        expect(govt.id).toBe("nova:128");
        expect(govt.name).toBe("Vell-os");
        expect(govt.prefix).toBe("nova");
    });

    it("projects class/ally/enemy groupings, dropping unused entries", async () => {
        const govt = await parseGovt();
        expect(govt.classes).toEqual([1, 2]);
        expect(govt.allies).toEqual([3]);
        expect(govt.enemies).toEqual([4, 5, 6]);
    });

    it("projects combat/skill fields", async () => {
        const govt = await parseGovt();
        expect(govt.maxOdds).toBe(300);
        expect(govt.skillMult).toBe(150);
        expect(govt.crimeTol).toBe(200);
    });

    it("projects inhJam as a four-tuple", async () => {
        const govt = await parseGovt();
        expect(govt.inhJam).toEqual([10, 20, 30, 40]);
    });

    it("projects legal-record penalties", async () => {
        const govt = await parseGovt();
        expect(govt.scanFine).toBe(-5);
        expect(govt.smugglePenalty).toBe(15);
        expect(govt.disablePenalty).toBe(30);
        expect(govt.boardPenalty).toBe(45);
        expect(govt.killPenalty).toBe(60);
        expect(govt.shootPenalty).toBe(5);
        expect(govt.initialRecord).toBe(-20);
        expect(govt.scanMask).toBe(0x8001);
    });

    it("decodes Flags1 into named booleans", async () => {
        const govt = await parseGovt();
        // 0x0243 = xenophobic | attacksPlayerIfCriminal | neverAttacksPlayer
        //          | warshipsTakeBribes
        expect(govt.flags.xenophobic).toBe(true);
        expect(govt.flags.attacksPlayerIfCriminal).toBe(true);
        expect(govt.flags.neverAttacksPlayer).toBe(true);
        expect(govt.flags.warshipsTakeBribes).toBe(true);
        expect(govt.flags.alwaysAttacksPlayer).toBe(false);
        expect(govt.flags.largerBribes).toBe(false);
    });

    it("decodes Flags2 into named booleans", async () => {
        const govt = await parseGovt();
        // 0x0091 = noAssistOrMercy | roadsideAssistance | prefersWormholes
        expect(govt.flags2.noAssistOrMercy).toBe(true);
        expect(govt.flags2.roadsideAssistance).toBe(true);
        expect(govt.flags2.prefersWormholes).toBe(true);
        expect(govt.flags2.minorMapBoundaries).toBe(false);
        expect(govt.flags2.doesntUseHypergates).toBe(false);
    });

    it("projects strings and colors", async () => {
        const govt = await parseGovt();
        expect(govt.commName).toBe("Vell-os");
        expect(govt.targetCode).toBe("VL");
        expect(govt.mediumName).toBe("the Vell-os");
        expect(govt.color).toBe(0x00ff8800);
        expect(govt.shipColor).toBe(0x00123456);
        expect(govt.voiceType).toBe(1003);
    });

    it("serializes the 64-bit require mask as a decimal string (JSON-safe)", async () => {
        const govt = await parseGovt();
        expect(typeof govt.require).toBe("string");
        expect(govt.require).toBe(0x0000000100000002n.toString());
        // GovtData must survive JSON round-tripping over the HTTP data route.
        expect(() => JSON.stringify(govt)).not.toThrow();
    });
});
