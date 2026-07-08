import 'jasmine';
import { Random } from './random_plugin.js';

describe('Random', () => {
    it('produces the same sequence for the same seed', () => {
        const a = new Random(123);
        const b = new Random(123);
        for (let i = 0; i < 100; i++) {
            expect(a.next()).toEqual(b.next());
        }
    });

    it('produces different sequences for different seeds', () => {
        const a = new Random(1);
        const b = new Random(2);
        const aValues = Array.from({ length: 10 }, () => a.next());
        const bValues = Array.from({ length: 10 }, () => b.next());
        expect(aValues).not.toEqual(bValues);
    });

    it('produces values in [0, 1)', () => {
        const random = new Random(42);
        for (let i = 0; i < 1000; i++) {
            const value = random.next();
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
    });

    it('below produces integers in [0, n)', () => {
        const random = new Random(7);
        const seen = new Set<number>();
        for (let i = 0; i < 200; i++) {
            const value = random.below(5);
            expect(Number.isInteger(value)).toBeTrue();
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(5);
            seen.add(value);
        }
        expect(seen.size).toBe(5);
    });

    it('resumes identically from saved state', () => {
        const a = new Random(99);
        for (let i = 0; i < 17; i++) {
            a.next();
        }
        const state = a.getState();
        const expected = Array.from({ length: 20 }, () => a.next());

        const b = new Random(1);
        b.setState(state);
        const resumed = Array.from({ length: 20 }, () => b.next());
        expect(resumed).toEqual(expected);
    });
});
