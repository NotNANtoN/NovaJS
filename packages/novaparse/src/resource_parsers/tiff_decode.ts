import { PNG } from "pngjs";

/**
 * Minimal decoder for the TIFFs that QuickTime embeds in PICT resources
 * (compressor 'tiff' with the "TIFF (Uncompressed)" codec): Compression=1,
 * chunky (PlanarConfiguration=1) RGB or RGBX, 8 bits per sample, either
 * byte order. This is not a general TIFF reader; anything else throws.
 */
export function decodeUncompressedTiff(d: DataView): PNG {
    const byteOrder = d.getUint16(0);
    let littleEndian: boolean;
    if (byteOrder === 0x4949) {
        littleEndian = true;
    } else if (byteOrder === 0x4D4D) {
        littleEndian = false;
    } else {
        throw new Error("Not a TIFF: bad byte order mark 0x" + byteOrder.toString(16));
    }
    const u16 = (o: number) => d.getUint16(o, littleEndian);
    const u32 = (o: number) => d.getUint32(o, littleEndian);
    if (u16(2) !== 42) {
        throw new Error("Not a TIFF: bad magic number " + u16(2));
    }

    // First IFD only; these images have a single one.
    const ifd = u32(4);
    const numTags = u16(ifd);
    const tags = new Map<number, { type: number, count: number, at: number }>();
    for (let i = 0; i < numTags; i++) {
        const entry = ifd + 2 + i * 12;
        tags.set(u16(entry), { type: u16(entry + 2), count: u32(entry + 4), at: entry + 8 });
    }

    function tagValues(tag: number): number[] | undefined {
        const t = tags.get(tag);
        if (!t) {
            return undefined;
        }
        if (t.type !== 3 && t.type !== 4) { // SHORT and LONG only
            throw new Error(`TIFF tag ${tag} has unsupported type ${t.type}`);
        }
        const size = t.type === 3 ? 2 : 4;
        const read = t.type === 3 ? u16 : u32;
        // Values <= 4 bytes are inline; larger ones are at an offset.
        const base = size * t.count <= 4 ? t.at : u32(t.at);
        const values = [];
        for (let i = 0; i < t.count; i++) {
            values.push(read(base + i * size));
        }
        return values;
    }
    const tagValue = (tag: number, fallback?: number): number => {
        const value = tagValues(tag)?.[0] ?? fallback;
        if (value === undefined) {
            throw new Error(`TIFF is missing required tag ${tag}`);
        }
        return value;
    };

    const width = tagValue(256);
    const height = tagValue(257);
    const compression = tagValue(259, 1);
    const photometric = tagValue(262);
    const samplesPerPixel = tagValue(277, 1);
    const planarConfig = tagValue(284, 1);
    const bitsPerSample = tagValues(258) ?? [1];
    if (compression !== 1) {
        throw new Error(`Unsupported TIFF compression ${compression} (only 1, uncompressed)`);
    }
    if (photometric !== 2) {
        throw new Error(`Unsupported TIFF photometric interpretation ${photometric} (only 2, RGB)`);
    }
    if (planarConfig !== 1) {
        throw new Error(`Unsupported TIFF planar configuration ${planarConfig} (only 1, chunky)`);
    }
    if (samplesPerPixel !== 3 && samplesPerPixel !== 4) {
        throw new Error(`Unsupported TIFF samples per pixel ${samplesPerPixel} (only 3 or 4)`);
    }
    if (bitsPerSample.some(b => b !== 8)) {
        throw new Error(`Unsupported TIFF bits per sample [${bitsPerSample}] (only 8)`);
    }

    const stripOffsets = tagValues(273);
    const stripByteCounts = tagValues(279);
    if (!stripOffsets || !stripByteCounts) {
        throw new Error("TIFF is missing strip location tags");
    }
    const rowsPerStrip = tagValue(278, height);

    const png = new PNG({ width, height });
    const rowBytes = width * samplesPerPixel;
    for (let strip = 0; strip < stripOffsets.length; strip++) {
        const stripRows = Math.min(rowsPerStrip, height - strip * rowsPerStrip);
        if (stripByteCounts[strip] < stripRows * rowBytes) {
            throw new Error(`TIFF strip ${strip} is too short`);
        }
        for (let r = 0; r < stripRows; r++) {
            const y = strip * rowsPerStrip + r;
            const src = stripOffsets[strip] + r * rowBytes;
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                png.data[idx] = d.getUint8(src + x * samplesPerPixel);
                png.data[idx + 1] = d.getUint8(src + x * samplesPerPixel + 1);
                png.data[idx + 2] = d.getUint8(src + x * samplesPerPixel + 2);
                // A 4th sample is QuickTime RGBX filler, not meaningful
                // alpha (QuickTime < 6.5 wrote non-standard RGBX; ResForge
                // disables it too). Force opaque.
                png.data[idx + 3] = 0xFF;
            }
        }
    }
    return png;
}
