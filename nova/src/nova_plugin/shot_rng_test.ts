import { createShotRng } from './shot_rng';

function sequence(seed: number, count = 16): number[] {
    const rng = createShotRng(seed);
    return Array.from({ length: count }, () => rng.next());
}

describe('shot rng', () => {
    it('repeats the same sequence for the same seed', () => {
        expect(sequence(0x1234_5678)).toEqual(sequence(0x1234_5678));
    });

    it('diverges for different seeds', () => {
        expect(sequence(1)).not.toEqual(sequence(2));
    });

    it('stays in the half-open unit interval', () => {
        for (const value of sequence(0xffff_ffff, 10_000)) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
    });
});
