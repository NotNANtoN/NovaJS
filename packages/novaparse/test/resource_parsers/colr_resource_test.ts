import "jasmine";
import { ColrResource } from "../../src/resource_parsers/colr_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A cölr resource with every field set to a distinct, recognizable value. */
function buildColr(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.uint32(0x00ff0000)                        // buttonUp
        .uint32(0x0000ff00)                     // buttonDown
        .uint32(0x000000ff)                     // buttonDisabled
        .string("Geneva", 0x40)                 // menuFont
        .int16(12)                              // menuFontSize
        .uint32(0x00112233)                     // menuBright
        .uint32(0x00445566)                     // menuDim
        .uint32(0x00778899)                     // gridBright
        .uint32(0x00aabbcc)                     // gridDim
        .array([1, 2, 3, 4], v => b.int16(v))   // progressBarPosition (RECT)
        .uint32(0x00ddeeff)                     // progressBright
        .uint32(0x00010203)                     // progressDim
        .uint32(0x00040506)                     // progressOutline
        // 6 menu-button points (x, y):
        .array([10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 60, 61],
            v => b.int16(v))
        .uint32(0x00707172)                     // floatingMapBorder
        .uint32(0x00737475)                     // listText
        .uint32(0x00767778)                     // listBackground
        .uint32(0x00797a7b)                     // listHighlight
        .uint32(0x007c7d7e)                     // escortHighlight
        .string("Helvetica", 0x40)              // buttonFont
        .int16(9)                               // buttonFontSize
        .int16(100).int16(101)                  // logoPosition (x, y)
        .int16(110).int16(111)                  // rolloverPosition
        .int16(120).int16(121)                  // slide1
        .int16(130).int16(131)                  // slide2
        .int16(140).int16(141);                 // slide3
    return b;
}

describe("ColrResource", () => {
    const idSpace = defaultIDSpace;

    let colr: ColrResource;

    beforeEach(() => {
        colr = new ColrResource(
            buildColr().resource("cölr", 128, "Colors"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 244 bytes is the size of every cölr in Nova's own data files.
        expect(buildColr().byteLength).toBe(244);
    });

    it("parses button colours", () => {
        expect(colr.buttonUp).toBe(0x00ff0000);
        expect(colr.buttonDown).toBe(0x0000ff00);
        expect(colr.buttonDisabled).toBe(0x000000ff);
    });

    it("parses menu font and colours", () => {
        expect(colr.menuFont).toBe("Geneva");
        expect(colr.menuFontSize).toBe(12);
        expect(colr.menuBright).toBe(0x00112233);
        expect(colr.menuDim).toBe(0x00445566);
    });

    it("parses grid colours", () => {
        expect(colr.gridBright).toBe(0x00778899);
        expect(colr.gridDim).toBe(0x00aabbcc);
    });

    it("parses the progress bar rect and colours", () => {
        expect(colr.progressBarPosition).toEqual({
            top: 1, left: 2, bottom: 3, right: 4,
        });
        expect(colr.progressBright).toBe(0x00ddeeff);
        expect(colr.progressDim).toBe(0x00010203);
        expect(colr.progressOutline).toBe(0x00040506);
    });

    it("parses the six menu button points", () => {
        expect(colr.menuButtons).toEqual([
            { x: 10, y: 11 },
            { x: 20, y: 21 },
            { x: 30, y: 31 },
            { x: 40, y: 41 },
            { x: 50, y: 51 },
            { x: 60, y: 61 },
        ]);
    });

    it("parses list and escort colours", () => {
        expect(colr.floatingMapBorder).toBe(0x00707172);
        expect(colr.listText).toBe(0x00737475);
        expect(colr.listBackground).toBe(0x00767778);
        expect(colr.listHighlight).toBe(0x00797a7b);
        expect(colr.escortHighlight).toBe(0x007c7d7e);
    });

    it("parses button font", () => {
        expect(colr.buttonFont).toBe("Helvetica");
        expect(colr.buttonFontSize).toBe(9);
    });

    it("parses logo, rollover and slide points", () => {
        expect(colr.logoPosition).toEqual({ x: 100, y: 101 });
        expect(colr.rolloverPosition).toEqual({ x: 110, y: 111 });
        expect(colr.slide1).toEqual({ x: 120, y: 121 });
        expect(colr.slide2).toEqual({ x: 130, y: 131 });
        expect(colr.slide3).toEqual({ x: 140, y: 141 });
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off immediately after menuFontSize (offset 78).
        const truncated = buildColr().truncate(78);
        const colr = new ColrResource(
            truncated.resource("cölr", 129, "Truncated"), idSpace);
        expect(colr.menuFontSize).toBe(12);
        expect(colr.menuBright).toBe(0);
        expect(colr.menuButtons).toEqual([
            { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
            { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
        ]);
        expect(colr.buttonFont).toBe("");
        expect(colr.slide3).toEqual({ x: 0, y: 0 });
    });
});
