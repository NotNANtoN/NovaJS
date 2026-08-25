import 'jasmine';
import {
    advanceExplosionTiming,
    explosionFrameDurationMs,
} from './explosion_timing';

describe('explosion presentation cadence', () => {
    it('converts retail FrameAdvance factors to 30 Hz frame durations', () => {
        expect(explosionFrameDurationMs(1)).toBeCloseTo(1000 / 30, 8);
        expect(explosionFrameDurationMs(0.5)).toBeCloseTo(2000 / 30, 8);
        expect(explosionFrameDurationMs(0.3)).toBeCloseTo(1000 / 9, 8);
    });

    it('advances from render time and completes exactly after its last frame', () => {
        const state = {};
        expect(advanceExplosionTiming(state, 0, 4, 1))
            .toEqual({ progress: 0, done: false });
        expect(advanceExplosionTiming(state, 1000 / 60, 4, 1).progress)
            .toBeCloseTo(0.125, 8);
        expect(advanceExplosionTiming(state, 1000 / 30, 4, 1))
            .toEqual(jasmine.objectContaining({
                progress: jasmine.any(Number),
                done: false,
            }));
        expect(advanceExplosionTiming(state, 1000 / 30, 4, 1).progress)
            .toBeCloseTo(0.25, 8);
        expect(advanceExplosionTiming(state, 4 * 1000 / 30, 4, 1))
            .toEqual({ progress: 1, done: true });
    });
});
