import { Angle } from 'nova_ecs/datatypes/angle';
import { getEvenlySpacedAngles } from './fire_weapon_plugin.js';

describe('getEvenlySpacedAngles', () => {
    // Compare numerically: Angle passes in-range values through
    // bit-exactly (re-rounding them broke rollback determinism), so
    // 0.6 + 0.3 stays 0.8999999999999999 rather than becoming 0.9.
    function expectAnglesCloseTo(actual: Angle[], expected: number[]) {
        expect(actual.length).toEqual(expected.length);
        for (let i = 0; i < expected.length; i++) {
            expect(actual[i].angle).toBeCloseTo(expected[i], 12);
        }
    }

    it('gets an even number of evenly spaced angles', () => {
        const actual = getEvenlySpacedAngles(0.6, 4);
        expectAnglesCloseTo(actual, [0.3, -0.3, 0.9, -0.9]);
    });

    it('gets an odd number of evenly spaced angles', () => {
        const actual = getEvenlySpacedAngles(0.6, 5);
        expectAnglesCloseTo(actual, [0, 0.6, -0.6, 1.2, -1.2]);
    });
});
