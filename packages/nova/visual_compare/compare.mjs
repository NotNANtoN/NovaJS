// Pixel-level region comparison built on pngjs + pixelmatch.
//
// Full-frame diffs are meaningless for this game (random starfield, live
// ship positions), so every comparison is scoped to a named REGION: a
// rectangle in the reference image paired with a rectangle in our capture.
// The two rectangles must share width/height but may sit at different
// offsets (in practice they are the same coords for right-anchored / centered
// chrome).
import fs from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export function readPng(filepath) {
    return PNG.sync.read(fs.readFileSync(filepath));
}

export function writePng(png, filepath) {
    fs.writeFileSync(filepath, PNG.sync.write(png));
}

/** Extract a rectangle from a PNG into a fresh PNG. Clamps to image bounds. */
export function crop(src, { x, y, width, height }) {
    const out = new PNG({ width, height });
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const sx = x + col;
            const sy = y + row;
            const di = (row * width + col) * 4;
            if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) {
                out.data[di] = 0; out.data[di + 1] = 0;
                out.data[di + 2] = 0; out.data[di + 3] = 255;
                continue;
            }
            const si = (sy * src.width + sx) * 4;
            out.data[di] = src.data[si];
            out.data[di + 1] = src.data[si + 1];
            out.data[di + 2] = src.data[si + 2];
            out.data[di + 3] = src.data[si + 3];
        }
    }
    return out;
}

/**
 * Compare a region between reference and ours.
 * @param region { id, label, ref:{x,y,width,height}, ours:{x,y,width,height}, threshold? }
 * @returns { diffPixels, totalPixels, diffPercent, refCrop, oursCrop, diffPng, width, height }
 */
export function compareRegion(refPng, oursPng, region) {
    const w = region.ref.width;
    const h = region.ref.height;
    const oursRect = region.ours ?? region.ref;
    if (oursRect.width !== w || oursRect.height !== h) {
        throw new Error(`Region ${region.id}: ref and ours rects must share size`);
    }
    const refCrop = crop(refPng, region.ref);
    const oursCrop = crop(oursPng, oursRect);
    const diffPng = new PNG({ width: w, height: h });
    const diffPixels = pixelmatch(
        refCrop.data, oursCrop.data, diffPng.data, w, h,
        { threshold: region.matchThreshold ?? 0.1, includeAA: false });
    const totalPixels = w * h;
    return {
        diffPixels,
        totalPixels,
        diffPercent: (diffPixels / totalPixels) * 100,
        refCrop,
        oursCrop,
        diffPng,
        width: w,
        height: h,
    };
}
