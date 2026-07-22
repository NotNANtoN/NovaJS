import "jasmine";
import { Resource } from "resource_fork";
import { PpatResource } from "../../src/resource_parsers/ppat_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/**
 * A 4x2, 8-bit full-colour ppat with a 3-entry colour table. Offsets:
 * header 0-27, PixMap 28-77, pixel data 78-85, colour table 86+.
 */
function buildPpat({ patType = 1, ctFlags = 0, values = [0, 1, 2] } = {}) {
    const b = new ResourceBuilder();
    // PixPat header.
    b.int16(patType)                    // patType
        .uint32(28)                     // patMap
        .uint32(78)                     // patData
        .uint32(0)                      // patXData
        .int16(-1)                      // patXValid
        .uint32(0)                      // patXMap
        .array([0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55],
            v => b.uint8(v));           // pat1Data (1-bit fallback)
    // PixMap record.
    b.uint32(0)                         // baseAddr
        .uint16(0x8000 | 4)             // rowBytes (flag bit + 4 bytes/row)
        .int16(0).int16(0)              // bounds.top, bounds.left
        .int16(2).int16(4)              // bounds.bottom, bounds.right
        .int16(0)                       // pmVersion
        .int16(0)                       // packType
        .uint32(0)                      // packSize
        .uint32(0x00480000)             // hRes (72 dpi)
        .uint32(0x00480000)             // vRes
        .int16(0)                       // pixelType (chunky indexed)
        .int16(8)                       // pixelSize
        .int16(1)                       // cmpCount
        .int16(8)                       // cmpSize
        .uint32(0)                      // planeBytes
        .uint32(86)                     // pmTable
        .uint32(0);                     // pmReserved
    // Pixel data: two rows of colour-table indices.
    b.array([0, 1, 2, 1], v => b.uint8(v));
    b.array([1, 0, 1, 2], v => b.uint8(v));
    // ColorTable: components store the byte in their high 8 bits.
    b.uint32(0)                         // ctSeed
        .uint16(ctFlags)                // ctFlags
        .int16(2);                      // ctSize (entries - 1)
    const components = [
        [0xab, 0, 0],
        [0, 0xcd, 0],
        [0, 0, 0xef],
    ];
    for (let i = 0; i < 3; i++) {
        b.uint16(values[i]);
        for (const c of components[i]) {
            b.uint16(c << 8);
        }
    }
    return b;
}

/** The RGBA pixel at (x, y). */
function pixelAt(ppat: PpatResource, x: number, y: number): number[] {
    return [...ppat.pixels.slice((y * ppat.width + x) * 4,
        (y * ppat.width + x) * 4 + 4)];
}

describe("PpatResource", () => {
    const idSpace = defaultIDSpace;

    it("parses a full-colour pattern", () => {
        const ppat = new PpatResource(
            buildPpat().resource("ppat", 128, "Test Pattern"), idSpace);
        expect(ppat.width).toBe(4);
        expect(ppat.height).toBe(2);
        expect(pixelAt(ppat, 0, 0)).toEqual([0xab, 0, 0, 255]);
        expect(pixelAt(ppat, 1, 0)).toEqual([0, 0xcd, 0, 255]);
        expect(pixelAt(ppat, 2, 0)).toEqual([0, 0, 0xef, 255]);
        expect(pixelAt(ppat, 0, 1)).toEqual([0, 0xcd, 0, 255]);
        expect(pixelAt(ppat, 1, 1)).toEqual([0xab, 0, 0, 255]);
    });

    it("uses implicit indices when the colour table is device-indexed", () => {
        // With ctFlags 0x8000 the entries' value fields are garbage and
        // entries apply in order.
        const ppat = new PpatResource(
            buildPpat({ ctFlags: 0x8000, values: [777, 888, 999] })
                .resource("ppat", 129, "Indexed"), idSpace);
        expect(pixelAt(ppat, 0, 0)).toEqual([0xab, 0, 0, 255]);
        expect(pixelAt(ppat, 2, 0)).toEqual([0, 0, 0xef, 255]);
    });

    it("falls back to the 8x8 1-bit pattern for old-style ppats", () => {
        const ppat = new PpatResource(
            buildPpat({ patType: 0 }).resource("ppat", 130, "Old"), idSpace);
        expect(ppat.width).toBe(8);
        expect(ppat.height).toBe(8);
        // pat1Data rows alternate 0xAA / 0x55: (0,0) is a set bit (black),
        // (1,0) is clear (white).
        expect(pixelAt(ppat, 0, 0)).toEqual([0, 0, 0, 255]);
        expect(pixelAt(ppat, 1, 0)).toEqual([255, 255, 255, 255]);
    });
});

/**
 * Malformed ppats must never throw (a RangeError here aborts the whole
 * readNovaFile call — fatal for the core Nova Files). Each attack degrades to
 * the 1-bit fallback (or a blank pixel when even that can't be read) and warns.
 */
describe("PpatResource (malformed, hostile input)", () => {
    const idSpace = defaultIDSpace;
    let warnSpy: jasmine.Spy;

    beforeEach(() => {
        warnSpy = spyOn(console, "warn");
    });

    // A ppat built from buildPpat() then mutated in place via `patch`, so each
    // attack starts from a valid resource and corrupts one field.
    function corruptPpat(patch: (view: DataView) => void) {
        const view = buildPpat().dataView();
        patch(view);
        return new Resource("ppat", 200, "Bad", view);
    }

    it("degrades when patMap points past the end", () => {
        // patMap (offset 2) = 0xFFFF: the PixMap record would read past the end.
        const ppat = new PpatResource(
            corruptPpat(v => v.setUint32(2, 0xffff)), idSpace);
        expect(ppat.width).toBe(8);   // 1-bit fallback
        expect(ppat.height).toBe(8);
        expect(warnSpy).toHaveBeenCalled();
    });

    it("degrades when pmTable (colour table) points past the end", () => {
        // pmTable lives at patMap + 42 = 28 + 42 = 70.
        const ppat = new PpatResource(
            corruptPpat(v => v.setUint32(70, 0x7fffffff)), idSpace);
        expect(ppat.width).toBe(8);
        expect(warnSpy.calls.mostRecent().args[0]).toMatch(/colour table/);
    });

    it("degrades on a huge colour-table size (ctSize)", () => {
        // ctSize is a signed int16 at pmTable + 6 = 86 + 6 = 92. 0x7fff entries
        // would read ~256KB past a tiny resource.
        const ppat = new PpatResource(
            corruptPpat(v => v.setInt16(92, 0x7fff)), idSpace);
        expect(ppat.width).toBe(8);
        expect(warnSpy.calls.mostRecent().args[0]).toMatch(/colour table/);
    });

    it("degrades when the pixel data runs past the end (rowBytes)", () => {
        // rowBytes at patMap + 4 = 32. A huge rowBytes overruns the resource.
        const ppat = new PpatResource(
            corruptPpat(v => v.setUint16(32, 0x8000 | 0x3000)), idSpace);
        expect(ppat.width).toBe(8);
        expect(warnSpy.calls.mostRecent().args[0]).toMatch(/pixel data/);
    });

    it("degrades a resource truncated mid-pixel-data", () => {
        // Full ppat is 86 + 32 = 118 bytes; cut the pixel data short.
        const ppat = new PpatResource(
            buildPpat().truncate(80).resource("ppat", 204, "Truncated"),
            idSpace);
        expect(ppat.width).toBe(8);   // 1-bit fallback (pat1Data still present)
        expect(warnSpy).toHaveBeenCalled();
    });

    it("degrades to a blank pixel when even the header is truncated", () => {
        // Shorter than the 28-byte PixPat header: no pat1Data to fall back to.
        const ppat = new PpatResource(
            buildPpat().truncate(10).resource("ppat", 205, "Stub"), idSpace);
        expect(ppat.width).toBe(1);
        expect(ppat.height).toBe(1);
        expect([...ppat.pixels]).toEqual([0, 0, 0, 0]);
        expect(warnSpy).toHaveBeenCalled();
    });
});
