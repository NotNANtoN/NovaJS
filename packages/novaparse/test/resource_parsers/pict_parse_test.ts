import "jasmine";
import { PICTParse } from "../../src/resource_parsers/pict_parse.js";

/** Little writer for hand-building PICT and TIFF bytes in tests. */
class Bytes {
    bytes: number[] = [];
    u8(v: number) { this.bytes.push(v & 0xFF); }
    u16(v: number) { this.u8(v >> 8); this.u8(v); }
    u32(v: number) { this.u16(v >>> 16); this.u16(v); }
    rect(h: number, w: number) { this.u16(0); this.u16(0); this.u16(h); this.u16(w); }
    zeros(n: number) { for (let i = 0; i < n; i++) this.u8(0); }
    push(...vs: number[]) { vs.forEach(v => this.u8(v)); }
    get length() { return this.bytes.length; }
    dataView(): DataView {
        return new DataView(new Uint8Array(this.bytes).buffer);
    }
}

/** PICT v2 preamble up to the start of the opcode stream. */
function pictHeader(b: Bytes, width: number, height: number) {
    b.u16(0); // unused size word
    b.rect(height, width); // frame
    b.u32(0x001102FF); // version 2
    b.u16(0x0C00); // extended header opcode
    b.u32(0xFFFE0000); // header version (rect variant)
    b.u32(0); b.u32(0); // reserved
    b.rect(height, width); // resolution rect
}

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

/**
 * A minimal big-endian uncompressed TIFF (single strip at offset 8), the
 * format QuickTime's "TIFF (Uncompressed)" codec embeds in PICTs.
 */
function buildTiff(width: number, height: number, samplesPerPixel: number,
    pixels: number[][]): Bytes {
    const b = new Bytes();
    const stripBytes = width * height * samplesPerPixel;
    b.u16(0x4D4D); // big-endian
    b.u16(42);
    b.u32(8 + stripBytes); // first IFD comes after the strip
    pixels.flat().forEach(v => b.u8(v));

    const bitsPerSampleOffset = 8 + stripBytes + 2 + 10 * 12 + 4;
    const tag = (id: number, type: number, count: number, value: number) => {
        b.u16(id); b.u16(type); b.u32(count);
        if (type === 3 && count === 1) { b.u16(value); b.u16(0); }
        else b.u32(value);
    };
    b.u16(10); // tag count
    tag(256, 3, 1, width);
    tag(257, 3, 1, height);
    tag(258, 3, samplesPerPixel, bitsPerSampleOffset);
    tag(259, 3, 1, 1); // uncompressed
    tag(262, 3, 1, 2); // RGB
    tag(273, 4, 1, 8); // strip offset
    tag(277, 3, 1, samplesPerPixel);
    tag(278, 3, 1, height); // rows per strip
    tag(279, 4, 1, stripBytes);
    tag(284, 3, 1, 1); // chunky
    b.u32(0); // next IFD
    for (let i = 0; i < samplesPerPixel; i++) {
        b.u16(8); // BitsPerSample array
    }
    return b;
}

/** A PICT whose image lives in a CompressedQuickTime (0x8200) opcode. */
function buildQuickTimePict(width: number, height: number,
    samplesPerPixel: number, pixels: number[][]): DataView {
    const tiff = buildTiff(width, height, samplesPerPixel, pixels);
    const b = new Bytes();
    pictHeader(b, width, height);
    b.u16(0x8200);
    b.u32(2 + 36 + 4 + 8 + 2 + 8 + 4 + 4 + 86 + tiff.length); // opcode data size
    b.u16(0); // version
    b.zeros(36); // transform matrix
    b.u32(0); // matte size
    b.rect(0, 0); // matte rect
    b.u16(0); // transfer mode
    b.rect(height, width); // source rect
    b.u32(0); // accuracy
    b.u32(0); // mask size
    // ImageDescription (86 bytes)
    b.u32(86);
    b.push(0x74, 0x69, 0x66, 0x66); // compressor 'tiff'
    b.zeros(4 + 2 + 2); // reserved, reserved, dataRefIndex
    b.u16(1); b.u16(1); // version, revision
    b.u32(0x6170706C); // vendor 'appl'
    b.u32(0); b.u32(0); // temporal/spatial quality
    b.u16(width); b.u16(height);
    b.u32(0x00480000); b.u32(0x00480000); // resolution
    b.u32(tiff.length); // data size
    b.u16(1); // frame count
    b.zeros(32); // name
    b.u16(24); // depth
    b.u16(0xFFFF); // clutID -1
    tiff.bytes.forEach(v => b.u8(v));
    if (b.length % 2 === 1) {
        b.u8(0);
    }
    b.u16(0x00FF); // eof
    return b.dataView();
}

describe("PICTParse CompressedQuickTime (embedded TIFF)", () => {
    it("decodes an embedded uncompressed RGB TIFF", () => {
        const pixels = [
            [10, 20, 30, /**/ 40, 50, 60],
            [70, 80, 90, /**/ 100, 110, 120],
        ];
        const png = new PICTParse(buildQuickTimePict(2, 2, 3, pixels)).PNG;
        expect(png.width).toBe(2);
        expect(png.height).toBe(2);
        expect([...png.data]).toEqual([
            10, 20, 30, 255, 40, 50, 60, 255,
            70, 80, 90, 255, 100, 110, 120, 255,
        ]);
    });

    it("ignores the RGBX filler alpha of 4-sample TIFFs (QuickTime writes" +
        " garbage there; honoring it blanks whole images)", () => {
        const pixels = [
            [10, 20, 30, 0, /**/ 40, 50, 60, 0],
            [70, 80, 90, 0, /**/ 100, 110, 120, 0],
        ];
        const png = new PICTParse(buildQuickTimePict(2, 2, 4, pixels)).PNG;
        expect([...png.data]).toEqual([
            10, 20, 30, 255, 40, 50, 60, 255,
            70, 80, 90, 255, 100, 110, 120, 255,
        ]);
    });
});

/** An indexed-color PICT drawn with packBitsRect/packBitsRgn. */
function buildIndexedPict(withMaskRegion: boolean, indexes: number[][],
    colors: [number, number, number][]): DataView {
    const width = indexes[0].length; // must be >= 8 so rows are packed
    const height = indexes.length;
    const b = new Bytes();
    pictHeader(b, width, height);
    b.u16(withMaskRegion ? 0x0099 : 0x0098);
    // PixMap (no baseAddress for indirect bits)
    b.u16(0x8000 | width); // rowBytes with pixmap flag; 1 byte per pixel
    b.rect(height, width); // bounds
    b.u16(0); // pmVersion
    b.u16(0); // packType (default)
    b.u32(0); // packSize
    b.u32(0x00480000); b.u32(0x00480000); // resolution
    b.u16(0); // pixelType: indexed
    b.u16(8); // pixelSize
    b.u16(1); b.u16(8); // cmpCount, cmpSize
    b.u32(0); b.u32(0); b.u32(0); // planeBytes, pmTable, pmReserved
    // ColorTable: a device table (flags 0x8000), entries in index order.
    b.u32(0); // ctSeed
    b.u16(0x8000); // ctFlags
    b.u16(colors.length - 1); // ctSize
    colors.forEach(([r, g, bl], i) => {
        b.u16(i); // value (unused for device tables)
        b.u16(r << 8); b.u16(g << 8); b.u16(bl << 8);
    });
    b.rect(height, width); // source
    b.rect(height, width); // destination
    b.u16(0); // mode
    if (withMaskRegion) {
        b.u16(10); // minimal region: just its size and rect
        b.rect(height, width);
    }
    for (const row of indexes) {
        b.u8(row.length + 1); // packedBytesCount
        b.u8(row.length - 1); // packbits literal run
        row.forEach(v => b.u8(v));
    }
    if (b.length % 2 === 1) {
        b.u8(0);
    }
    b.u16(0x00FF); // eof
    return b.dataView();
}

describe("PICTParse indexed pixmaps (packBitsRect/packBitsRgn)", () => {
    const colors: [number, number, number][] =
        [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
    const indexes = [
        [0, 1, 2, 3, 3, 2, 1, 0],
        [3, 3, 0, 0, 1, 1, 2, 2],
    ];

    function expectIndexesDecoded(png: import("pngjs").PNG) {
        expect(png.width).toBe(8);
        expect(png.height).toBe(2);
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 8; x++) {
                const idx = (y * 8 + x) * 4;
                expect([png.data[idx], png.data[idx + 1], png.data[idx + 2]])
                    .toEqual([...colors[indexes[y][x]]]);
                expect(png.data[idx + 3]).toBe(255);
            }
        }
    }

    it("maps packBitsRect indexes through the color table", () => {
        expectIndexesDecoded(new PICTParse(buildIndexedPict(false, indexes, colors)).PNG);
    });

    it("skips the packBitsRgn mask region before the pixel data", () => {
        expectIndexesDecoded(new PICTParse(buildIndexedPict(true, indexes, colors)).PNG);
    });
});

describe("PICTParse opcode skipping", () => {
    it("skips state, shape, text, and reserved opcodes before the image", () => {
        const width = 4, height = 2;
        const b = new Bytes();
        pictHeader(b, width, height);
        b.u16(0x001C); // hiliteMode: no data
        b.u16(0x0032); b.rect(height, width); // eraseRect
        b.u16(0x001F); b.zeros(6); // opColor
        b.u16(0x0028); b.zeros(4); b.u8(2); b.push(0x48, 0x69); // longText "Hi"
        b.u8(0); // opcodes are word-aligned
        b.u16(0x00A2); b.u16(4); b.zeros(4); // reserved, 2-byte length
        b.u16(0x0100); b.zeros(2); // reserved, fixed 2 bytes
        b.u16(0x8123); b.u32(3); b.zeros(3); // reserved, 4-byte length (odd)
        b.u8(0); // opcodes are word-aligned
        // Now a real packType 4 image.
        b.u16(0x009A);
        b.u32(0); // baseAddress
        b.u16(0x8000 | (4 * width)); // rowBytes
        b.rect(height, width); // bounds
        b.u16(0); b.u16(4); b.u32(0); // pmVersion, packType, packSize
        b.u32(0x00480000); b.u32(0x00480000);
        b.u16(16); b.u16(32); b.u16(3); b.u16(8); // pixelType, pixelSize, cmpCount, cmpSize
        b.u32(0); b.u32(0); b.u32(0);
        b.rect(height, width); b.rect(height, width); b.u16(0);
        for (let y = 0; y < height; y++) {
            const planes = [
                [1, 2, 3, 4].map(v => v * (y + 1)), // R
                [5, 6, 7, 8].map(v => v * (y + 1)), // G
                [9, 10, 11, 12].map(v => v * (y + 1)), // B
            ].flat();
            b.u8(planes.length + 1);
            b.u8(planes.length - 1);
            planes.forEach(v => b.u8(v));
        }
        if (b.length % 2 === 1) {
            b.u8(0);
        }
        b.u16(0x00FF);

        const png = new PICTParse(b.dataView()).PNG;
        expect(png.width).toBe(4);
        expect(png.height).toBe(2);
        // Spot-check a pixel per row to prove the stream stayed aligned.
        expect([...png.data.slice(0, 4)]).toEqual([1, 5, 9, 255]);
        expect([...png.data.slice(16, 20)]).toEqual([2, 10, 18, 255]);
    });
});
