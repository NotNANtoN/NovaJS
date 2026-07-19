import "jasmine";
import { readResourceFork } from "resource_fork";
import { CicnResource } from "../../src/resource_parsers/cicn_resource.js";
import { getEmptyNovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { resolveFixture } from "../fixtures.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/**
 * A synthetic cicn: a WxH indexed colour icon with a 1-bit mask.
 *
 *   PixMap (50 bytes)  colour image, `pixelSize` bits/pixel
 *   Mask BitMap (14)   1-bit alpha
 *   Icon BitMap (14)   1-bit icon (ignored by the parser)
 *   iconData (4)       handle, ignored
 *   mask data          maskRowBytes * H
 *   bitmap data        iconRowBytes * H
 *   ColorTable         value/r/g/b entries
 *   pixel data         pmRowBytes * H
 */
function buildCicn({
    width = 4,
    height = 2,
    pixelSize = 8,
    ctFlags = 0,
    // Colour-table entry `value` fields (ignored when ctFlags has 0x8000).
    values = [0, 1, 2],
    // One packed byte per pixel row for pixelSize=8; caller supplies rows.
    pixelRows = [[0, 1, 2, 1], [1, 0, 1, 2]],
    // 1-bit mask, one number (row bits, msb-first) per row.
    maskRows = [0b11110000, 0b11000000],
} = {}) {
    const pmRowBytes = Math.ceil((width * pixelSize) / 8);
    const maskRowBytes = Math.ceil(width / 8);
    const iconRowBytes = maskRowBytes;

    const b = new ResourceBuilder();
    // PixMap record (50 bytes).
    b.uint32(0)                             // baseAddr
        .uint16(0x8000 | pmRowBytes)        // rowBytes (+ flag bit)
        .int16(0).int16(0)                  // bounds.top, bounds.left
        .int16(height).int16(width)         // bounds.bottom, bounds.right
        .int16(0)                           // pmVersion
        .int16(0)                           // packType
        .uint32(0)                          // packSize
        .uint32(0x00480000)                 // hRes
        .uint32(0x00480000)                 // vRes
        .int16(0)                           // pixelType
        .int16(pixelSize)                   // pixelSize
        .int16(1)                           // cmpCount
        .int16(pixelSize)                   // cmpSize
        .uint32(0)                          // planeBytes
        .uint32(0)                          // pmTable (on-disk table follows data)
        .uint32(0);                         // pmReserved
    // Mask BitMap (14 bytes).
    b.uint32(0)                             // baseAddr
        .uint16(maskRowBytes)               // rowBytes
        .int16(0).int16(0).int16(height).int16(width); // bounds
    // Icon BitMap (14 bytes).
    b.uint32(0)
        .uint16(iconRowBytes)
        .int16(0).int16(0).int16(height).int16(width);
    // iconData handle.
    b.uint32(0);
    // Mask data.
    for (const row of maskRows) {
        for (let byte = 0; byte < maskRowBytes; byte++) {
            b.uint8((row >> (8 * (maskRowBytes - 1 - byte))) & 0xff);
        }
    }
    // Icon bitmap data (unused by the parser; write zeros).
    b.array(new Array(iconRowBytes * height).fill(0), v => b.uint8(v));
    // ColorTable.
    b.uint32(0)                             // ctSeed
        .uint16(ctFlags)                    // ctFlags
        .int16(values.length - 1);          // ctSize (entries - 1)
    const components = [
        [0xab, 0, 0],
        [0, 0xcd, 0],
        [0, 0, 0xef],
    ];
    for (let i = 0; i < values.length; i++) {
        b.uint16(values[i]);
        for (const c of components[i]) {
            b.uint16(c << 8);
        }
    }
    // Pixel data (packed indices). For pixelSize=8 each entry is one byte.
    for (const row of pixelRows) {
        for (const v of row) {
            b.uint8(v);
        }
        // pad row to pmRowBytes
        for (let pad = row.length; pad < pmRowBytes; pad++) {
            b.uint8(0);
        }
    }
    return b;
}

function pixelAt(c: CicnResource, x: number, y: number): number[] {
    return [...c.pixels.slice((y * c.width + x) * 4, (y * c.width + x) * 4 + 4)];
}

describe("CicnResource (synthetic)", () => {
    const idSpace = defaultIDSpace;

    it("decodes an indexed colour icon and applies the mask as alpha", () => {
        const c = new CicnResource(
            buildCicn().resource("cicn", 128, "Test"), idSpace);
        expect(c.width).toBe(4);
        expect(c.height).toBe(2);
        // Row 0 mask 0b1111 -> all opaque; colours from indices 0,1,2,1.
        expect(pixelAt(c, 0, 0)).toEqual([0xab, 0, 0, 255]);
        expect(pixelAt(c, 1, 0)).toEqual([0, 0xcd, 0, 255]);
        expect(pixelAt(c, 2, 0)).toEqual([0, 0, 0xef, 255]);
        expect(pixelAt(c, 3, 0)).toEqual([0, 0xcd, 0, 255]);
        // Row 1 mask 0b1100 -> first two opaque, last two transparent.
        expect(pixelAt(c, 0, 1)).toEqual([0, 0xcd, 0, 255]);
        expect(pixelAt(c, 1, 1)).toEqual([0xab, 0, 0, 255]);
        expect(pixelAt(c, 2, 1)[3]).toBe(0);
        expect(pixelAt(c, 3, 1)[3]).toBe(0);
    });

    it("uses implicit indices for a device-indexed colour table", () => {
        // With ctFlags 0x8000 the entries' value fields are garbage and
        // entries apply in order.
        const c = new CicnResource(
            buildCicn({ ctFlags: 0x8000, values: [777, 888, 999] })
                .resource("cicn", 129, "Indexed"), idSpace);
        expect(pixelAt(c, 0, 0)).toEqual([0xab, 0, 0, 255]);
        expect(pixelAt(c, 2, 0)).toEqual([0, 0, 0xef, 255]);
    });

    it("unpacks 4-bit pixels with odd (non-byte-aligned) row widths", () => {
        // width 3, 4-bit: pmRowBytes = ceil(3*4/8) = 2, so each row has a
        // trailing half-byte of padding. Indices per row: [0,1,2], [2,1,0].
        const c = new CicnResource(buildCicn({
            width: 3,
            height: 2,
            pixelSize: 4,
            pixelRows: [[0x01, 0x20], [0x21, 0x00]], // packed nibbles
            maskRows: [0b11100000, 0b11100000],
        }).resource("cicn", 130, "Odd"), idSpace);
        expect(c.width).toBe(3);
        expect(pixelAt(c, 0, 0)).toEqual([0xab, 0, 0, 255]); // index 0
        expect(pixelAt(c, 1, 0)).toEqual([0, 0xcd, 0, 255]); // index 1
        expect(pixelAt(c, 2, 0)).toEqual([0, 0, 0xef, 255]); // index 2
        expect(pixelAt(c, 0, 1)).toEqual([0, 0, 0xef, 255]); // index 2
        expect(pixelAt(c, 2, 1)).toEqual([0xab, 0, 0, 255]); // index 0
    });

    it("degrades a malformed icon to a blank pixel instead of throwing", () => {
        // pixelSize 16 is not an indexed depth we support.
        const c = new CicnResource(
            buildCicn({ pixelSize: 16 }).resource("cicn", 131, "Bad"),
            idSpace);
        expect(c.width).toBe(1);
        expect(c.height).toBe(1);
        expect([...c.pixels]).toEqual([0, 0, 0, 0]);
    });
});

describe("CicnResource (real Nova data)", () => {
    const idSpace = getEmptyNovaResources();
    let hostile: CicnResource;  // 10008, hostile target corner (red)
    let neutral: CicnResource;  // 10012, neutral target corner (yellow)

    beforeAll(async () => {
        // The hostile corner set (10008-10011) and the neutral set
        // (10012-10015) live in separate fixtures extracted from
        // "Nova Graphics 1".
        const hostileRf = await readResourceFork(
            resolveFixture("resource_examples/cicn_hostile_corners.ndat"),
            false);
        const neutralRf = await readResourceFork(
            resolveFixture("resource_examples/cicn.ndat"), false);
        hostile = new CicnResource(hostileRf["cicn"][10008], idSpace);
        neutral = new CicnResource(neutralRf["cicn"][10012], idSpace);
    });

    it("decodes the hostile target corner (cicn 10008) as 16x16", () => {
        expect(hostile.width).toBe(16);
        expect(hostile.height).toBe(16);
    });

    it("makes the hostile corner red where the bracket is drawn", () => {
        // The bracket occupies the top-left; (5,0) is on the bracket.
        const [r, g, b, a] = pixelAt(hostile, 5, 0);
        expect(a).toBe(255);
        expect(r).toBeGreaterThan(80);   // strongly red
        expect(g).toBeLessThan(80);
        expect(b).toBeLessThan(80);
    });

    it("makes the empty (bottom-right) region transparent", () => {
        expect(pixelAt(hostile, 15, 15)[3]).toBe(0);
        expect(pixelAt(hostile, 0, 0)[3]).toBe(0);
    });

    it("decodes the neutral target corner (cicn 10012) as yellow", () => {
        expect(neutral.width).toBe(16);
        expect(neutral.height).toBe(16);
        // Average colour over opaque pixels is yellow (high R and G, low B).
        let rs = 0, gs = 0, bs = 0, n = 0;
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
                const [r, g, b, a] = pixelAt(neutral, x, y);
                if (a > 0) { rs += r; gs += g; bs += b; n++; }
            }
        }
        expect(n).toBeGreaterThan(0);
        expect(rs / n).toBeGreaterThan(40);
        expect(gs / n).toBeGreaterThan(40);
        expect(bs / n).toBeLessThan(20);
    });
});
