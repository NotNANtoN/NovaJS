export function init(): Promise<void>;

export function isInitialized(): boolean;

export function convexHull(points: Float32Array): Float32Array;

export function convexHullRgba(
    rgba: Uint8Array,
    width: number,
    height: number,
    alphaThreshold: number,
): Float32Array;

export function satBatch(
    aVertices: Float32Array,
    aOffsets: Uint32Array,
    aPositions: Float32Array,
    aRotations: Float32Array,
    bVertices: Float32Array,
    bOffsets: Uint32Array,
    bPositions: Float32Array,
    bRotations: Float32Array,
    pairs: Uint32Array,
): Uint8Array;
