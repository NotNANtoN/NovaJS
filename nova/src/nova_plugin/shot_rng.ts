export interface ShotRng {
    next(): number;
}

/**
 * Mulberry32 is small enough to instantiate for every shot while retaining a
 * stable, fully specified 32-bit sequence across JavaScript runtimes.
 */
export function createShotRng(seed: number): ShotRng {
    let state = seed >>> 0;
    return {
        next() {
            state = (state + 0x6d2b79f5) >>> 0;
            let value = state;
            value = Math.imul(value ^ value >>> 15, value | 1);
            value ^= value + Math.imul(value ^ value >>> 7, value | 61);
            return ((value ^ value >>> 14) >>> 0) / 0x1_0000_0000;
        },
    };
}

export function randomShotSeed(): number {
    const words = new Uint32Array(1);
    globalThis.crypto.getRandomValues(words);
    return words[0];
}
