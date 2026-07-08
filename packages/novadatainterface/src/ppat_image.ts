import defaultPict from './default_pict.js';

/**
 * A ppat (classic Mac pixel-pattern) resource rendered as a PNG. Nova
 * Graphics 1 holds ten of them (ids 128-137), which the engine tiles over
 * the radar as sensor static.
 */
export type PpatImageData = ArrayBuffer;

export function getDefaultPpatImageData(): PpatImageData {
    return Buffer.from(defaultPict.buffer).buffer;
}
