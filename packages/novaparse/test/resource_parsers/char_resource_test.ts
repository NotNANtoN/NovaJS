import "jasmine";
import { CharResource } from "../../src/resource_parsers/char_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A chär resource with every field set to a distinct, recognizable value. */
function buildChar(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int32(50000)                              // startingCredits
        .int16(128)                             // startingShip
        .array([200, 201, -1, -1], v => b.int16(v))   // startingSystems
        .array([128, 129, 130, -1], v => b.int16(v))  // govts
        .array([50, -30, 100, 0], v => b.int16(v))    // statuses
        .int16(42)                              // combatRating
        .array([1000, 1001, -1, -1], v => b.int16(v)) // introPicts
        .array([5, 10, 15, 20], v => b.int16(v))      // delays
        .int16(3000)                            // introText
        .string("b !S128 !S200", 0x100)         // onStart (NCB, raw)
        .uint16(0x0001)                         // flags
        .int16(15)                              // startingDay
        .int16(6)                               // startingMonth
        .int16(1177)                            // startingYear
        .string("Stardate ", 0x10)              // datePrefix
        .string(" NC", 0x10)                    // dateSuffix
        .skip(0x10);                            // unused
    return b;
}

describe("CharResource", () => {
    const idSpace = defaultIDSpace;

    let char: CharResource;

    beforeEach(() => {
        char = new CharResource(
            buildChar().resource("chär", 128, "Trader"), idSpace);
    });

    it("builds a real-data-size resource", () => {
        // Real Nova chär resources are 362 bytes. ResForge's TMPL reports 356
        // because its FCNT list collapses the four Starting System entries
        // (8 bytes) to a single 2-byte entry in the offset table; the real
        // resource stores all four, adding the 6 "missing" bytes inline.
        expect(buildChar().byteLength).toBe(362);
    });

    it("parses startingCredits and startingShip", () => {
        expect(char.startingCredits).toBe(50000);
        expect(char.startingShip).toBe(128);
    });

    it("parses startingSystems, dropping unused entries", () => {
        expect(char.startingSystems).toEqual([200, 201]);
    });

    it("parses govt statuses, dropping unused entries", () => {
        expect(char.govtStatuses).toEqual([
            { govt: 128, status: 50 },
            { govt: 129, status: -30 },
            { govt: 130, status: 100 },
        ]);
    });

    it("parses combatRating", () => {
        expect(char.combatRating).toBe(42);
    });

    it("parses intro picts, dropping unused entries", () => {
        expect(char.introPicts).toEqual([
            { pict: 1000, delay: 5 },
            { pict: 1001, delay: 10 },
        ]);
    });

    it("parses introText", () => {
        expect(char.introText).toBe(3000);
    });

    it("parses onStart as a raw NCB string", () => {
        expect(char.onStart).toBe("b !S128 !S200");
    });

    it("parses flags", () => {
        expect(char.flags).toBe(0x0001);
        expect(char.isDefault).toBe(true);
    });

    it("parses the start date", () => {
        expect(char.startingDay).toBe(15);
        expect(char.startingMonth).toBe(6);
        expect(char.startingYear).toBe(1177);
        expect(char.datePrefix).toBe("Stardate ");
        expect(char.dateSuffix).toBe(" NC");
    });

    it("ignores extra trailing bytes beyond what it consumes", () => {
        // The parser reads exactly 362 bytes; any extra trailing data must be
        // left unread (the Reader simply never advances into it).
        const withTrailer = buildChar();
        withTrailer.skip(6);
        expect(withTrailer.byteLength).toBe(368);
        const parsed = new CharResource(
            withTrailer.resource("chär", 131, "Trailer"), idSpace);
        expect(parsed.startingCredits).toBe(50000);
        expect(parsed.dateSuffix).toBe(" NC");
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off immediately after combatRating (offset 32: credits 4 +
        // ship 2 + systems 8 + govts 8 + statuses 8 + combatRating 2).
        const truncated = buildChar().truncate(32);
        const char = new CharResource(
            truncated.resource("chär", 129, "Truncated"), idSpace);
        expect(char.combatRating).toBe(42);
        expect(char.introPicts).toEqual([]);
        expect(char.onStart).toBe("");
        expect(char.flags).toBe(0);
        expect(char.datePrefix).toBe("");
    });
});
