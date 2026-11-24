import { Angle } from 'nova_ecs/datatypes/angle';
import { Entity } from 'nova_ecs/entity';
import {
    AttackIntentComponent,
    attackOriginLocked,
    getEvenlySpacedAngles,
    getRandomInCone,
    inheritedAttackTarget,
    isAngleInTurretBlindSpot,
    sampleInaccuracy,
    setAttackIntent,
    WeaponsComponent,
    WeaponsComponentProvider,
} from './fire_weapon_plugin';
import { World } from 'nova_ecs/world';
import { WeaponsStateComponent } from './weapons_state';
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

describe('turret blind spots', () => {
    it('blocks firing into configured front, side, and rear blind spots', () => {
        const heading = new Angle(0);
        expect(isAngleInTurretBlindSpot(heading, new Angle(0), { front: true, side: false, back: false })).toBeTrue();
        expect(isAngleInTurretBlindSpot(heading, new Angle(Math.PI), { front: true, side: false, back: false })).toBeFalse();
        expect(isAngleInTurretBlindSpot(heading, new Angle(Math.PI / 2), { front: false, side: true, back: false })).toBeTrue();
        expect(isAngleInTurretBlindSpot(heading, new Angle(-Math.PI / 2), { front: false, side: true, back: false })).toBeTrue();
        expect(isAngleInTurretBlindSpot(heading, new Angle(Math.PI), { front: false, side: false, back: true })).toBeTrue();
        expect(isAngleInTurretBlindSpot(heading, new Angle(0), { front: false, side: false, back: true })).toBeFalse();
    });
});

describe('WeaponsComponentProvider', () => {
    it('preserves kept weapon state while pruning removed weapons and seeding new ones', () => {
        const world = new World('weapons-provider-test');
        world.addSystem(WeaponsComponentProvider);
        const ship = new Entity('ship');
        ship.components.set(WeaponsStateComponent, new Map([
            ['blaster', { count: 2, firing: false }],
            ['laser', { count: 1, firing: false }],
        ]));
        world.entities.set('ship', ship);
        world.step();

        const local = ship.components.get(WeaponsComponent)!;
        local.get('blaster').burstCount = 3;
        local.get('laser').burstCount = 2;

        // Swap laser for missile; blaster state persists, laser is pruned, missile is seeded.
        ship.components.set(WeaponsStateComponent, new Map([
            ['blaster', { count: 2, firing: false }],
            ['missile', { count: 1, firing: false }],
        ]));
        world.step();

        const updated = ship.components.get(WeaponsComponent)!;
        expect(updated.get('blaster').burstCount).toBe(3);
        expect(updated.has('laser')).toBeFalse();
        expect(updated.has('missile')).toBeTrue();
    });
});
