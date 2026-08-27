export interface ZoomPoint {
    x: number;
    y: number;
}

/**
 * The natural galaxy spread remains visible at the low end while the high end
 * makes labels and local routes useful. A wider range would make the sparse
 * map either unusably tiny or too easy to lose.
 */
export const MAP_SCALE_MIN = 0.5;
export const MAP_SCALE_DEFAULT = 2;
export const MAP_SCALE_MAX = 4;

export function clampMapScale(scale: number): number {
    if (!Number.isFinite(scale)) {
        return MAP_SCALE_DEFAULT;
    }
    return Math.min(MAP_SCALE_MAX, Math.max(MAP_SCALE_MIN, scale));
}

/**
 * Convert a wheel delta into a multiplicative zoom. Exponential scaling makes
 * trackpad gestures and traditional wheel notches feel consistent.
 */
export function mapScaleForWheel(
    scale: number,
    deltaY: number,
): number {
    if (!Number.isFinite(deltaY)) {
        return clampMapScale(scale);
    }
    return clampMapScale(scale * Math.exp(-deltaY * 0.0015));
}

/**
 * Move the scaled map so the galaxy point under `pointer` stays there.
 *
 * `position` and `pointer` are in the same map-well coordinate space.
 */
export function zoomedMapPosition(
    position: ZoomPoint,
    pointer: ZoomPoint,
    oldScale: number,
    newScale: number,
): ZoomPoint {
    if (!Number.isFinite(oldScale) || oldScale === 0
        || !Number.isFinite(newScale)) {
        return { ...position };
    }
    const worldX = (pointer.x - position.x) / oldScale;
    const worldY = (pointer.y - position.y) / oldScale;
    return {
        x: pointer.x - worldX * newScale,
        y: pointer.y - worldY * newScale,
    };
}
