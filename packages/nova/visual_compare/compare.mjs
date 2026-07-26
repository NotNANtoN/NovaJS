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

// pixelmatch paints each COUNTED (non-anti-aliased) difference this exact
// color in the diff image; anti-aliased near-misses are painted yellow and
// are NOT counted. Counting these red pixels per grid cell therefore
// reproduces the overall diffPixels, split spatially.
const DIFF_RED = [255, 0, 0];

function isDiffPixel(data, i) {
    return data[i] === DIFF_RED[0]
        && data[i + 1] === DIFF_RED[1]
        && data[i + 2] === DIFF_RED[2];
}

/**
 * Chooses a grid for a region: aim for ~16x16 cells, but never make a cell
 * smaller than ~8px, so tiny regions get proportionally fewer, still-
 * meaningful cells.
 */
function gridDims(w, h, target = 16, minCell = 8) {
    const cols = Math.max(1, Math.min(target, Math.floor(w / minCell)));
    const rows = Math.max(1, Math.min(target, Math.floor(h / minCell)));
    return { cols, rows };
}

/**
 * Splits the diff into a grid and measures how CONCENTRATED it is. A region
 * can read "2% different" overall while every differing pixel sits in one
 * cell — a misplaced widget — which should read as suspicious, not fine.
 *
 * Returns per-cell diff densities plus summary metrics:
 *   - maxCellPercent: the worst cell's diff density (% of that cell's pixels)
 *   - meanCellPercent: mean cell density (≈ the overall diff % for equal cells)
 *   - concentration: maxCellDensity / meanCellDensity — 1 means the error is
 *     spread evenly, large means it is piled into a few cells.
 *   - worst: the worst cell's location/size/counts, for hotspot visualization.
 */
export function computeConcentration(diffPng, w, h) {
    const { cols, rows } = gridDims(w, h);
    const cells = [];
    let maxDensity = 0;
    let densitySum = 0;
    let worst = null;
    for (let row = 0; row < rows; row++) {
        // Distribute the remainder so cells tile the region exactly.
        const y0 = Math.floor((row * h) / rows);
        const y1 = Math.floor(((row + 1) * h) / rows);
        for (let col = 0; col < cols; col++) {
            const x0 = Math.floor((col * w) / cols);
            const x1 = Math.floor(((col + 1) * w) / cols);
            const cw = x1 - x0;
            const ch = y1 - y0;
            const cellTotal = cw * ch;
            let diff = 0;
            for (let y = y0; y < y1; y++) {
                let i = (y * w + x0) * 4;
                for (let x = x0; x < x1; x++, i += 4) {
                    if (isDiffPixel(diffPng.data, i)) {
                        diff++;
                    }
                }
            }
            const density = cellTotal > 0 ? diff / cellTotal : 0;
            const cell = {
                col, row, x: x0, y: y0, w: cw, h: ch,
                diffPixels: diff, totalPixels: cellTotal, density,
            };
            cells.push(cell);
            densitySum += density;
            if (density > maxDensity) {
                maxDensity = density;
                worst = cell;
            }
        }
    }
    const meanDensity = cells.length > 0 ? densitySum / cells.length : 0;
    const concentration = meanDensity > 0 ? maxDensity / meanDensity : 0;
    return {
        cols, rows, cells,
        maxCellDensity: maxDensity,
        meanCellDensity: meanDensity,
        maxCellPercent: maxDensity * 100,
        meanCellPercent: meanDensity * 100,
        concentration,
        worst,
    };
}

/**
 * Renders a hotspot heatmap for the report: the "ours" crop tinted red in
 * proportion to each cell's diff density, with the worst cell outlined in
 * bright green. Makes a low-overall-but-concentrated region legible at a
 * glance.
 */
export function renderConcentrationHeatmap(oursCrop, grid, w, h) {
    const out = new PNG({ width: w, height: h });
    out.data.set(oursCrop.data);
    // Per-pixel density lookup via the cell grid.
    const cellDensity = (x, y) => {
        // cells are row-major; find via proportional index (cheap enough).
        const col = Math.min(grid.cols - 1, Math.floor((x * grid.cols) / w));
        const row = Math.min(grid.rows - 1, Math.floor((y * grid.rows) / h));
        return grid.cells[row * grid.cols + col]?.density ?? 0;
    };
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const d = cellDensity(x, y);
            if (d <= 0) {
                continue;
            }
            // Blend toward red by the cell density (capped so even a fully-
            // different cell keeps a little of the underlying image).
            const a = Math.min(0.85, 0.15 + d * 0.85);
            out.data[i] = Math.round(out.data[i] * (1 - a) + 255 * a);
            out.data[i + 1] = Math.round(out.data[i + 1] * (1 - a));
            out.data[i + 2] = Math.round(out.data[i + 2] * (1 - a));
        }
    }
    // Outline the worst cell in green.
    const wc = grid.worst;
    if (wc && wc.diffPixels > 0) {
        const green = [0, 255, 0];
        const paint = (x, y) => {
            if (x < 0 || y < 0 || x >= w || y >= h) {
                return;
            }
            const i = (y * w + x) * 4;
            out.data[i] = green[0];
            out.data[i + 1] = green[1];
            out.data[i + 2] = green[2];
            out.data[i + 3] = 255;
        };
        for (let x = wc.x; x < wc.x + wc.w; x++) {
            paint(x, wc.y);
            paint(x, wc.y + wc.h - 1);
        }
        for (let y = wc.y; y < wc.y + wc.h; y++) {
            paint(wc.x, y);
            paint(wc.x + wc.w - 1, y);
        }
    }
    return out;
}

/**
 * Compare a region between reference and ours.
 * @param region { id, label, ref:{x,y,width,height}, ours:{x,y,width,height}, threshold? }
 * @returns { diffPixels, totalPixels, diffPercent, refCrop, oursCrop, diffPng,
 *            heatmapPng, grid, width, height }
 *
 * The `grid` field (see computeConcentration) and `heatmapPng` are additive;
 * every previously-returned field is unchanged.
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
    const grid = computeConcentration(diffPng, w, h);
    const heatmapPng = renderConcentrationHeatmap(oursCrop, grid, w, h);
    return {
        diffPixels,
        totalPixels,
        diffPercent: (diffPixels / totalPixels) * 100,
        refCrop,
        oursCrop,
        diffPng,
        heatmapPng,
        grid,
        width: w,
        height: h,
    };
}
