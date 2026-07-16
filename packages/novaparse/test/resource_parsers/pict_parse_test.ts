import "jasmine";
import { PICTParse } from "../../src/resource_parsers/pict_parse.js";

/**
 * Builds a minimal 4x2 PICT v2 with a directBitsRect whose pixel data is
 * 32-bit component-packed (packType 4): each scanline is cmpCount planes of
 * `width` bytes ([AAAA]RRRRGGGGBBBB), each packbits-encoded as one literal
 * run. This is the format of third-party plug-in outfit/ship images that
 * historically rendered yellow (RGB: blue plane dropped) or red (ARGB: green
 * and blue planes dropped).
 */
function buildPackType4Pict(cmpCount: 3 | 4, planes: number[][][]): DataView {
    const width = 4;
    const height = 2;
    const rowBytes = 4 * width;
    const bytes: number[] = [];
    const u8 = (v: number) => bytes.push(v & 0xFF);
    const u16 = (v: number) => { u8(v >> 8); u8(v); };
    const u32 = (v: number) => { u16(v >>> 16); u16(v); };
    const rect = (h: number, w: number) => { u16(0); u16(0); u16(h); u16(w); };

    u16(0); // unused size word
    rect(height, width); // frame
    u32(0x001102FF); // version 2
    u16(0x0C00); // extended header opcode
    u32(0xFFFE0000); // header version (rect variant)
    u32(0); u32(0); // reserved
    rect(height, width); // resolution rect

    u16(0x009A); // directBitsRect
    // PixMap
    u32(0); // baseAddress
    u16(0x8000 | rowBytes); // rowBytes with pixmap flag
    rect(height, width); // bounds
    u16(0); // pmVersion
    u16(4); // packType: component-packed
    u32(0); // packSize
    u32(0x00480000); u32(0x00480000); // hRes, vRes
    u16(16); // pixelType: RGBDirect
    u16(32); // pixelSize
    u16(cmpCount);
    u16(8); // cmpSize
    u32(0); u32(0); u32(0); // planeBytes, pmTable, pmReserved

    rect(height, width); // source
    rect(height, width); // destination
    u16(0); // mode

    for (let y = 0; y < height; y++) {
        const scanline = planes[y].flat();
        u8(scanline.length + 1); // packedBytesCount (count byte + literals)
        u8(scanline.length - 1); // packbits literal run of scanline.length
        scanline.forEach(u8);
    }

    if (bytes.length % 2 === 1) {
        u8(0); // opcodes are word-aligned
    }
    u16(0x00FF); // eof

    return new DataView(new Uint8Array(bytes).buffer);
}

describe("PICTParse packType 4 (component-packed direct bits)", () => {
    const R = [[10, 20, 30, 40], [11, 21, 31, 41]];
    const G = [[50, 60, 70, 80], [51, 61, 71, 81]];
    const B = [[90, 100, 110, 120], [91, 101, 111, 121]];

    function expectPlanesDecoded(png: import("pngjs").PNG) {
        expect(png.width).toBe(4);
        expect(png.height).toBe(2);
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 4; x++) {
                const idx = (y * 4 + x) * 4;
                expect(png.data[idx]).toBe(R[y][x]);
                expect(png.data[idx + 1]).toBe(G[y][x]);
                expect(png.data[idx + 2]).toBe(B[y][x]);
                expect(png.data[idx + 3]).toBe(255);
            }
        }
    }

    it("decodes all three planes of RGB data (regression: blue was dropped," +
        " tinting images yellow)", () => {
        const pict = buildPackType4Pict(3, [
            [R[0], G[0], B[0]],
            [R[1], G[1], B[1]],
        ]);
        expectPlanesDecoded(new PICTParse(pict).PNG);
    });

    it("skips the alpha plane of ARGB data and forces opaque (regression:" +
        " green and blue were dropped, tinting images red)", () => {
        // The alpha plane is garbage in the wild; QuickDraw ignores it.
        const junkAlpha = [[7, 0, 255, 3], [0, 128, 9, 200]];
        const pict = buildPackType4Pict(4, [
            [junkAlpha[0], R[0], G[0], B[0]],
            [junkAlpha[1], R[1], G[1], B[1]],
        ]);
        expectPlanesDecoded(new PICTParse(pict).PNG);
    });
});
