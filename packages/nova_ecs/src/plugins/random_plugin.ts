import { Plugin } from '../plugin.js';
import { Resource } from '../resource.js';

export type RandomState = [number, number, number, number];

/**
 * A small, fast, seedable PRNG (sfc32). Simulation code must use this
 * instead of Math.random so that runs are deterministic and the
 * generator state can be included in rollback snapshots.
 */
export class Random {
    private a: number;
    private b: number;
    private c: number;
    private d: number;

    constructor(seed = 0x9e3779b9) {
        // Expand the seed with splitmix32.
        let s = seed >>> 0;
        const splitmix = () => {
            s = (s + 0x9e3779b9) | 0;
            let z = s;
            z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
            z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
            return (z ^ (z >>> 15)) >>> 0;
        };
        this.a = splitmix();
        this.b = splitmix();
        this.c = splitmix();
        this.d = splitmix();
        // Mix the state a bit.
        for (let i = 0; i < 8; i++) {
            this.next();
        }
    }

    /** Uniform float in [0, 1), like Math.random. */
    next(): number {
        this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
        const t = (this.a + this.b) | 0;
        this.a = this.b ^ (this.b >>> 9);
        this.b = (this.c + (this.c << 3)) | 0;
        this.c = (this.c << 21) | (this.c >>> 11);
        this.d = (this.d + 1) | 0;
        const result = (t + this.d) | 0;
        this.c = (this.c + result) | 0;
        return (result >>> 0) / 4294967296;
    }

    /** Uniform integer in [0, n). */
    below(n: number): number {
        return Math.floor(this.next() * n);
    }

    getState(): RandomState {
        return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
    }

    setState(state: RandomState) {
        [this.a, this.b, this.c, this.d] = state;
    }
}

export const RandomResource = new Resource<Random>('Random');

export const RandomPlugin: Plugin = {
    name: 'RandomPlugin',
    build(world) {
        if (!world.resources.has(RandomResource)) {
            world.resources.set(RandomResource, new Random());
        }
    }
};
