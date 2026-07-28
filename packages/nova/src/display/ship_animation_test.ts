import 'jasmine';
import { continuousRawSet, foldSetIndex } from './ship_animation_plugin.js';

describe('foldSetIndex (fold progress -> base sprite set)', () => {
    it('maps folded (0) to set 0 and unfolded (1) to the last set', () => {
        expect(foldSetIndex(0, 6)).toBe(0);
        expect(foldSetIndex(1, 6)).toBe(5);
    });

    it('maps intermediate progress linearly across the sets', () => {
        // 6 sets -> 5 gaps; 0.5 -> 2.5 -> rounds to 3 (round-half-up).
        expect(foldSetIndex(0.4, 6)).toBe(2); // 2.0
        expect(foldSetIndex(0.5, 6)).toBe(3); // 2.5 -> 3
        expect(foldSetIndex(0.8, 6)).toBe(4); // 4.0
    });

    it('clamps out-of-range progress into [0, baseSetCount-1]', () => {
        expect(foldSetIndex(-1, 6)).toBe(0);
        expect(foldSetIndex(2, 6)).toBe(5);
    });
});

describe('continuousRawSet (spin phase -> raw set index)', () => {
    it('advances setsPerSecond sets each second', () => {
        // 6 sets/second: at t=0 set 0, at t=1000ms set 6 (before mod).
        expect(continuousRawSet(0, 6)).toBe(0);
        expect(continuousRawSet(1000, 6)).toBe(6);
        expect(continuousRawSet(500, 6)).toBe(3);
    });

    it('is monotonic and floors within a set interval', () => {
        // A set lasts 1/6 s ~= 166.7ms; anything inside it holds one index.
        expect(continuousRawSet(100, 6)).toBe(0);
        expect(continuousRawSet(166, 6)).toBe(0);
        expect(continuousRawSet(167, 6)).toBe(1);
    });

    it('composes with rotation via a per-sheet modulo', () => {
        // The Manticore base image holds 3 sets; the raw index wraps.
        const raw = continuousRawSet(1000, 6); // 6
        expect(raw % 3).toBe(0);
        expect(continuousRawSet(1167, 6) % 3).toBe(7 % 3); // 1
    });
});
