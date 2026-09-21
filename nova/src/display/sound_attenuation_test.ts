import 'jasmine';
import {
    soundDistance,
    distanceAttenuation,
    worldSoundVolume,
    worldSoundPan,
    SOUND_FULL_VOLUME_RADIUS,
    SOUND_SILENCE_RADIUS,
} from './sound_attenuation';
import { BOUNDARY } from 'nova_ecs/datatypes/position';

describe('sound_attenuation', () => {
    it('returns full volume for close sounds', () => {
        expect(distanceAttenuation(0)).toBe(1);
        expect(distanceAttenuation(SOUND_FULL_VOLUME_RADIUS)).toBe(1);
    });

    it('returns zero volume for distant sounds', () => {
        expect(distanceAttenuation(SOUND_SILENCE_RADIUS)).toBe(0);
        expect(distanceAttenuation(SOUND_SILENCE_RADIUS + 1000)).toBe(0);
    });

    it('scales linearly between full volume and silence', () => {
        const mid = (SOUND_FULL_VOLUME_RADIUS + SOUND_SILENCE_RADIUS) / 2;
        expect(distanceAttenuation(mid)).toBeCloseTo(0.5, 2);
    });

    it('wraps distances across system boundaries', () => {
        const p1 = { x: -BOUNDARY + 50, y: 0 };
        const p2 = { x: BOUNDARY - 50, y: 0 };
        expect(soundDistance(p1, p2)).toBe(100);
    });

    it('calculates stereo pan accurately', () => {
        const listener = { x: 0, y: 0 };
        const center = { x: 0, y: 500 };
        const left = { x: -700, y: 0 };
        const right = { x: 700, y: 0 };

        expect(worldSoundPan(center, listener)).toBe(0);
        expect(worldSoundPan(left, listener)).toBeCloseTo(-0.5, 2);
        expect(worldSoundPan(right, listener)).toBeCloseTo(0.5, 2);
    });

    it('wraps stereo pan across system boundary', () => {
        const listener = { x: -BOUNDARY + 100, y: 0 };
        const source = { x: BOUNDARY - 100, y: 0 };
        // Source is 200 units to the left across the wrap
        expect(worldSoundPan(source, listener, 1000)).toBeCloseTo(-0.2, 2);
    });
});
