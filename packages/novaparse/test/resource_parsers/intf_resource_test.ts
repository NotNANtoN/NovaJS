import "jasmine";
import { IntfResource } from "../../src/resource_parsers/intf_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** An ïntf resource with every field set to a distinct, recognizable value. */
function buildIntf(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.uint32(0x00ffffff)                        // brightText
        .uint32(0x00808080)                     // dimText
        .array([1, 2, 3, 4], v => b.int16(v))   // radarArea
        .uint32(0x00ff0000)                     // brightRadar
        .uint32(0x00800000)                     // dimRadar
        .array([5, 6, 7, 8], v => b.int16(v))   // shieldArea
        .uint32(0x000000ff)                     // shieldColor
        .array([9, 10, 11, 12], v => b.int16(v))// armorArea
        .uint32(0x0000ff00)                     // armorColor
        .array([13, 14, 15, 16], v => b.int16(v))// fuelArea
        .uint32(0x0000ffff)                     // fuelFull
        .uint32(0x00008080)                     // fuelPartial
        .array([17, 18, 19, 20], v => b.int16(v))// navArea
        .array([21, 22, 23, 24], v => b.int16(v))// weaponArea
        .array([25, 26, 27, 28], v => b.int16(v))// targetArea
        .array([29, 30, 31, 32], v => b.int16(v))// cargoArea
        .string("Geneva", 0x40)                 // statusFont
        .int16(10)                              // statusFontSize
        .int16(9)                               // subtitleSize
        .int16(9500);                           // statusBackground
    return b;
}

describe("IntfResource", () => {
    const idSpace = defaultIDSpace;

    let intf: IntfResource;

    beforeEach(() => {
        intf = new IntfResource(
            buildIntf().resource("ïntf", 128, "Status Bar"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 166 bytes is the size of every ïntf in Nova's own data files.
        expect(buildIntf().byteLength).toBe(166);
    });

    it("parses text colours", () => {
        expect(intf.brightText).toBe(0x00ffffff);
        expect(intf.dimText).toBe(0x00808080);
    });

    it("parses the radar area and colours", () => {
        expect(intf.radarArea).toEqual({ top: 1, left: 2, bottom: 3, right: 4 });
        expect(intf.brightRadar).toBe(0x00ff0000);
        expect(intf.dimRadar).toBe(0x00800000);
    });

    it("parses the shield area and colour", () => {
        expect(intf.shieldArea).toEqual({ top: 5, left: 6, bottom: 7, right: 8 });
        expect(intf.shieldColor).toBe(0x000000ff);
    });

    it("parses the armor area and colour", () => {
        expect(intf.armorArea).toEqual({
            top: 9, left: 10, bottom: 11, right: 12,
        });
        expect(intf.armorColor).toBe(0x0000ff00);
    });

    it("parses the fuel area and colours", () => {
        expect(intf.fuelArea).toEqual({
            top: 13, left: 14, bottom: 15, right: 16,
        });
        expect(intf.fuelFull).toBe(0x0000ffff);
        expect(intf.fuelPartial).toBe(0x00008080);
    });

    it("parses the remaining display areas", () => {
        expect(intf.navArea).toEqual({ top: 17, left: 18, bottom: 19, right: 20 });
        expect(intf.weaponArea).toEqual({
            top: 21, left: 22, bottom: 23, right: 24,
        });
        expect(intf.targetArea).toEqual({
            top: 25, left: 26, bottom: 27, right: 28,
        });
        expect(intf.cargoArea).toEqual({
            top: 29, left: 30, bottom: 31, right: 32,
        });
    });

    it("parses fonts and background", () => {
        expect(intf.statusFont).toBe("Geneva");
        expect(intf.statusFontSize).toBe(10);
        expect(intf.subtitleSize).toBe(9);
        expect(intf.statusBackground).toBe(9500);
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off immediately after shieldColor (offset 36).
        const truncated = buildIntf().truncate(36);
        const intf = new IntfResource(
            truncated.resource("ïntf", 129, "Truncated"), idSpace);
        expect(intf.shieldColor).toBe(0x000000ff);
        expect(intf.armorArea).toEqual({ top: 0, left: 0, bottom: 0, right: 0 });
        expect(intf.statusFont).toBe("");
        expect(intf.statusBackground).toBe(-1);
    });
});
