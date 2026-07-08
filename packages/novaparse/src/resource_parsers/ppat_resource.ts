import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * A classic Mac colour pixel pattern (Inside Macintosh: Imaging With
 * QuickDraw, the PixPat record): a small image tiled to fill an area. Nova
 * ships ten of them in Nova Graphics 1 (ids 128-137), which the engine tiles
 * over the radar as sensor static.
 *
 * Resource layout (all offsets from the start of the resource data):
 *
 *   PixPat header (28 bytes):
 *      0  patType   int16   pattern kind; 1 = full-colour
 *      2  patMap    uint32  offset to the PixMap record
 *      6  patData   uint32  offset to the indexed pixel data
 *     10  patXData  uint32  \
 *     14  patXValid int16    | expanded-data cache; meaningless on disk
 *     16  patXMap   uint32  /
 *     20  pat1Data  8 bytes old-style 8x8 1-bit fallback pattern
 *
 *   PixMap record (at patMap, 50 bytes):
 *     +4  rowBytes  uint16  bytes per pixel row (top 2 bits are flags)
 *     +6  bounds    int16 x4: top, left, bottom, right
 *    +32  pixelSize int16   bits per pixel (indexed: 1, 2, 4, or 8)
 *    +42  pmTable   uint32  offset to the colour table
 *
 *   ColorTable (at pmTable):
 *     +4  ctFlags   uint16  0x8000: entry values are implicit indices
 *     +6  ctSize    int16   number of entries minus one
 *     +8  entries   8 bytes each: value, r, g, b (components use the high
 *                   byte of a 16-bit value)
 */
export class PpatResource extends BaseResource {
    width: number;
    height: number;
    /** Row-major RGBA pixels, 4 bytes per pixel, fully opaque. */
    pixels: Uint8ClampedArray;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const d = this.data;

        const patType = d.getInt16(0);
        if (patType !== 1) {
            // Old-style (type 0) or dither (type 2) pattern: fall back to the
            // 8x8 1-bit pattern every ppat carries at offset 20.
            ({ width: this.width, height: this.height, pixels: this.pixels } =
                parsePat1Data(d));
            return;
        }

        const patMap = d.getUint32(2);
        const patData = d.getUint32(6);

        const rowBytes = d.getUint16(patMap + 4) & 0x3fff;
        const top = d.getInt16(patMap + 6);
        const left = d.getInt16(patMap + 8);
        const bottom = d.getInt16(patMap + 10);
        const right = d.getInt16(patMap + 12);
        const pixelSize = d.getInt16(patMap + 32);
        const pmTable = d.getUint32(patMap + 42);

        this.width = right - left;
        this.height = bottom - top;
        if (this.width <= 0 || this.height <= 0
            || ![1, 2, 4, 8].includes(pixelSize)) {
            // Malformed or exotic (direct-colour) pattern. Resources parse
            // eagerly at file load, so degrade to the 1-bit fallback rather
            // than failing the whole file.
            console.warn(`ppat id ${this.id} is malformed or unsupported `
                + `(bounds ${this.width}x${this.height}, `
                + `pixel size ${pixelSize}); using its 1-bit fallback`);
            ({ width: this.width, height: this.height, pixels: this.pixels } =
                parsePat1Data(d));
            return;
        }

        const colors = parseColorTable(d, pmTable, pixelSize);

        this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
        const pixelsPerByte = 8 / pixelSize;
        const mask = (1 << pixelSize) - 1;
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const byte = d.getUint8(
                    patData + y * rowBytes + Math.floor(x / pixelsPerByte));
                const shift = 8 - pixelSize * (x % pixelsPerByte + 1);
                const index = (byte >> shift) & mask;
                const color = colors[index] ?? [0, 0, 0];
                const out = (y * this.width + x) * 4;
                this.pixels[out] = color[0];
                this.pixels[out + 1] = color[1];
                this.pixels[out + 2] = color[2];
                this.pixels[out + 3] = 255;
            }
        }
    }
}

type RGB = [number, number, number];

/** Reads a QuickDraw ColorTable into a pixel-value -> RGB lookup. */
function parseColorTable(d: DataView, pmTable: number,
    pixelSize: number): RGB[] {
    const ctFlags = d.getUint16(pmTable + 4);
    const ctSize = d.getInt16(pmTable + 6);
    // When the high flag bit is set the entries' value fields are garbage
    // and entries apply in order (Inside Macintosh: "indexed device" tables).
    const sequentialValues = (ctFlags & 0x8000) !== 0;

    const colors: RGB[] = [];
    for (let i = 0; i <= ctSize; i++) {
        const entry = pmTable + 8 + i * 8;
        const value = sequentialValues ? i : d.getUint16(entry);
        colors[value & ((1 << pixelSize) - 1)] = [
            d.getUint8(entry + 2), // High byte of each 16-bit component.
            d.getUint8(entry + 4),
            d.getUint8(entry + 6),
        ];
    }
    return colors;
}

/** The old-style 8x8 1-bit pattern at offset 20: set bits are black. */
function parsePat1Data(d: DataView) {
    const pixels = new Uint8ClampedArray(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
        const row = d.getUint8(20 + y);
        for (let x = 0; x < 8; x++) {
            const black = (row >> (7 - x)) & 1;
            const value = black ? 0 : 255;
            const out = (y * 8 + x) * 4;
            pixels[out] = value;
            pixels[out + 1] = value;
            pixels[out + 2] = value;
            pixels[out + 3] = 255;
        }
    }
    return { width: 8, height: 8, pixels };
}
