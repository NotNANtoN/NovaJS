import { Angle } from 'nova_ecs/datatypes/angle';
import { Entity } from 'nova_ecs/entity';
import {
    AttackIntentComponent,
    attackOriginLocked,
    getEvenlySpacedAngles,
    getRandomInCone,
    inheritedAttackTarget,
    sampleInaccuracy,
    setAttackIntent,
} from './fire_weapon_plugin';
import { createShotRng } from './shot_rng';

describe('getEvenlySpacedAngles', () => {
    it('gets an even number of evenly spaced angles', () => {
        const actual = getEvenlySpacedAngles(0.6, 4);
        const expected = [
            new Angle(0.3),
            new Angle(-0.3),
            new Angle(0.9),
            new Angle(-0.9),
        ];
        expect(actual).toEqual(expected);
    });

    it('gets an odd number of evenly spaced angles', () => {
        const actual = getEvenlySpacedAngles(0.6, 5);
        const expected = [
            new Angle(0),
            new Angle(0.6),
            new Angle(-0.6),
            new Angle(1.2),
            new Angle(-1.2),
        ];
        expect(actual).toEqual(expected);
    });
});

describe('seeded shot spread', () => {
    it('samples identical inaccuracy for an identical seed', () => {
        expect(sampleInaccuracy(12, createShotRng(42)))
            .toBe(sampleInaccuracy(12, createShotRng(42)));
    });

    it('samples identical submunition cones for an identical seed', () => {
        expect(getRandomInCone(0.5, 8, createShotRng(99)))
            .toEqual(getRandomInCone(0.5, 8, createShotRng(99)));
    });
});

describe('shot attack intent', () => {
    it('captures a target immutably and clears it for pooled reuse', () => {
        const shot = new Entity('shot');
        setAttackIntent(shot, 'selected-target');
        expect(shot.components.get(AttackIntentComponent))
            .toEqual({ target: 'selected-target' });

        setAttackIntent(shot, undefined);
        expect(shot.components.has(AttackIntentComponent)).toBeFalse();
    });

    it('keeps the original intent when guided submunitions retarget', () => {
        expect(inheritedAttackTarget(
            'later-guidance-target',
            { target: 'selected-at-fire-time' },
        )).toBe('selected-at-fire-time');
        expect(inheritedAttackTarget('current-target', undefined))
            .toBe('current-target');
    });
});

describe('weapon spawn lockout', () => {
    for (const producer of ['projectile', 'beam']) {
        it(`blocks ${producer} spawn after destruction starts`, () => {
            expect(attackOriginLocked(true, 100)).toBeTrue();
            expect(attackOriginLocked(undefined, 0)).toBeTrue();
            expect(attackOriginLocked(undefined, 100)).toBeFalse();
        });
    }
});
