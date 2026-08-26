/**
 * The political overlay on the galaxy map: each system claimed by a
 * government tints the space around it with that government's map colour,
 * and neighbouring claims blend into each other so the result reads as a
 * smooth tessellation rather than a scatter of discs.
 *
 * This is deliberately free of rendering dependencies: it produces an RGBA
 * buffer in galaxy coordinates which the starmap uploads as a texture and
 * scales with the map.
 */

export interface TerritoryPoint {
    x: number;
    y: number;
    /** Government map colour as 0xRRGGBB. */
    color: number;
    /** Lets callers filter the field down to the systems a pilot knows. */
    systemId?: string;
}

export interface TerritoryField {
    /** Top-left corner of the field in galaxy coordinates. */
    origin: { x: number, y: number };
    /** Extent of the field in galaxy coordinates. */
    size: { x: number, y: number };
    width: number;
    height: number;
    /** RGBA, row major, `width * height * 4` bytes. */
    pixels: Uint8ClampedArray;
}

export interface TerritoryFieldOptions {
    /** Longest side of the generated texture, in pixels. */
    maxResolution?: number;
    /** Overrides the reach of a single system, in galaxy units. */
    radius?: number;
}

const DEFAULT_MAX_RESOLUTION = 384;
/**
 * A system's reach as a multiple of the typical distance between systems.
 * It has to be several times the spacing, otherwise neighbouring claims do
 * not overlap and the overlay reads as separate bubbles instead of one
 * continuous territory.
 */
const REACH_MULTIPLIER = 5;
const MIN_RADIUS = 20;
const MAX_RADIUS = 400;
/** Keeps the weight finite on top of a system. */
const WEIGHT_SOFTENING = 1;
/** How quickly overlapping claims reach full opacity. */
const COVERAGE_GAIN = 2.5;
/** Darkest channel value a government's colour is allowed to render at. */
const MIN_BRIGHTNESS = 0x50;

/**
 * Systems are not spread evenly, so the reach is derived from the median
 * distance to a system's nearest neighbour. That keeps dense cores from
 * smearing together and lone systems from claiming half the galaxy.
 */
export function territoryRadius(points: readonly TerritoryPoint[]): number {
    if (points.length < 2) {
        return MIN_RADIUS * REACH_MULTIPLIER;
    }
    const nearest = points.map(point => {
        let best = Infinity;
        for (const other of points) {
            if (other === point) {
                continue;
            }
            const distance = (other.x - point.x) ** 2 + (other.y - point.y) ** 2;
            if (distance < best) {
                best = distance;
            }
        }
        return Math.sqrt(best);
    }).filter(distance => Number.isFinite(distance)).sort((a, b) => a - b);
    if (nearest.length === 0) {
        return MIN_RADIUS * REACH_MULTIPLIER;
    }
    const median = nearest[Math.floor(nearest.length / 2)];
    return Math.min(
        MAX_RADIUS, Math.max(MIN_RADIUS, median) * REACH_MULTIPLIER);
}

/**
 * A few governments carry very dark map colours (the Wild Geese are almost
 * black). Left alone they punch what looks like a hole in the overlay, so
 * every colour is lifted to a readable brightness while keeping its hue.
 */
export function readableColor(color: number): number {
    const red = (color >> 16) & 0xff;
    const green = (color >> 8) & 0xff;
    const blue = color & 0xff;
    const brightest = Math.max(red, green, blue);
    if (brightest >= MIN_BRIGHTNESS) {
        return color;
    }
    if (brightest === 0) {
        return (MIN_BRIGHTNESS << 16) | (MIN_BRIGHTNESS << 8) | MIN_BRIGHTNESS;
    }
    const gain = MIN_BRIGHTNESS / brightest;
    return (Math.round(red * gain) << 16)
        | (Math.round(green * gain) << 8)
        | Math.round(blue * gain);
}

export function computeTerritoryField(
    points: readonly TerritoryPoint[],
    options: TerritoryFieldOptions = {},
): TerritoryField | undefined {
    if (points.length === 0) {
        return undefined;
    }
    points = points.map(point => ({
        ...point, color: readableColor(point.color),
    }));
    const radius = options.radius ?? territoryRadius(points);
    const maxResolution = options.maxResolution ?? DEFAULT_MAX_RESOLUTION;

    const minX = Math.min(...points.map(point => point.x)) - radius;
    const minY = Math.min(...points.map(point => point.y)) - radius;
    const maxX = Math.max(...points.map(point => point.x)) + radius;
    const maxY = Math.max(...points.map(point => point.y)) + radius;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);

    const longest = Math.max(spanX, spanY);
    const scale = maxResolution / longest;
    const width = Math.max(1, Math.round(spanX * scale));
    const height = Math.max(1, Math.round(spanY * scale));

    // Bucket the systems so each pixel only tests its own neighbourhood.
    const buckets = new Map<string, TerritoryPoint[]>();
    const bucketKey = (x: number, y: number) =>
        `${Math.floor(x / radius)}:${Math.floor(y / radius)}`;
    for (const point of points) {
        const key = bucketKey(point.x, point.y);
        const bucket = buckets.get(key);
        if (bucket) {
            bucket.push(point);
        } else {
            buckets.set(key, [point]);
        }
    }

    const pixels = new Uint8ClampedArray(width * height * 4);
    const radiusSquared = radius * radius;
    for (let row = 0; row < height; row++) {
        const y = minY + (row + 0.5) * spanY / height;
        const bucketY = Math.floor(y / radius);
        for (let column = 0; column < width; column++) {
            const x = minX + (column + 0.5) * spanX / width;
            const bucketX = Math.floor(x / radius);

            let weightSum = 0;
            let red = 0;
            let green = 0;
            let blue = 0;
            let coverage = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const bucket = buckets.get(
                        `${bucketX + dx}:${bucketY + dy}`);
                    if (!bucket) {
                        continue;
                    }
                    for (const point of bucket) {
                        const distanceSquared =
                            (point.x - x) ** 2 + (point.y - y) ** 2;
                        if (distanceSquared >= radiusSquared) {
                            continue;
                        }
                        // Inverse square weighting makes a system's own
                        // colour dominate nearby and hands over quickly at
                        // the midpoint between two governments.
                        const weight = 1 / (distanceSquared + WEIGHT_SOFTENING);
                        weightSum += weight;
                        red += ((point.color >> 16) & 0xff) * weight;
                        green += ((point.color >> 8) & 0xff) * weight;
                        blue += (point.color & 0xff) * weight;
                        // Coverage accumulates so the inside of a cluster
                        // fills in solidly and only the frontier fades.
                        coverage +=
                            (1 - Math.sqrt(distanceSquared) / radius) ** 2;
                    }
                }
            }

            const offset = (row * width + column) * 4;
            if (weightSum === 0) {
                continue;
            }
            pixels[offset] = red / weightSum;
            pixels[offset + 1] = green / weightSum;
            pixels[offset + 2] = blue / weightSum;
            // Fade out towards unclaimed space instead of ending on a hard
            // circle edge.
            pixels[offset + 3] = 255 * Math.min(
                1, coverage * COVERAGE_GAIN);
        }
    }

    return {
        origin: { x: minX, y: minY },
        size: { x: spanX, y: spanY },
        width,
        height,
        pixels,
    };
}
