/**
 * Shared QuickDraw decoding helpers (Inside Macintosh: Imaging With
 * QuickDraw). Both ppat (PixPat) and cicn (IconData) embed the same PixMap +
 * ColorTable structures, so the low-level bit twiddling lives here.
 */

export type RGB = [number, number, number];

/**
 * Reads a QuickDraw ColorTable into a pixel-value -> RGB lookup.
 *
 *   ColorTable (at pmTable):
 *     +0  ctSeed    uint32
 *     +4  ctFlags   uint16  0x8000: entry values are implicit indices
 *     +6  ctSize    int16   number of entries minus one
 *     +8  entries   8 bytes each: value, r, g, b (components use the high
 *                   byte of a 16-bit value)
 */
export function parseColorTable(d: DataView, pmTable: number,
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

/**
 * The number of ColorTable bytes at pmTable: 8-byte header plus 8 bytes per
 * entry. cicn packs the pixel data immediately after the table, so callers
 * need this to find where the table ends.
 */
export function colorTableByteLength(d: DataView, pmTable: number): number {
    const ctSize = d.getInt16(pmTable + 6);
    return 8 + (ctSize + 1) * 8;
}

/**
 * Reads one indexed pixel from packed (1/2/4/8-bit) chunky pixel data and
 * returns its RGB colour. `base` is the offset of the first pixel row.
 */
export function readIndexedPixel(d: DataView, base: number, rowBytes: number,
    x: number, y: number, pixelSize: number, colors: RGB[]): RGB {
    const pixelsPerByte = 8 / pixelSize;
    const mask = (1 << pixelSize) - 1;
    const byte = d.getUint8(base + y * rowBytes + Math.floor(x / pixelsPerByte));
    const shift = 8 - pixelSize * (x % pixelsPerByte + 1);
    const index = (byte >> shift) & mask;
    return colors[index] ?? [0, 0, 0];
}

/** Reads a single bit (msb-first) from a 1-bit bitmap row. */
export function readBit(d: DataView, base: number, rowBytes: number,
    x: number, y: number): number {
    const byte = d.getUint8(base + y * rowBytes + (x >> 3));
    return (byte >> (7 - (x & 7))) & 1;
}
