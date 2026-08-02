import { Animation, getDefaultExitPoints } from 'novadatainterface/animation';
import { WeaponData } from 'novadatainterface/weapon_data';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState } from 'nova_ecs/plugins/movement_plugin';
import {
    defaultWeaponLocalState, getEvenlySpacedAngles, getNextExitpoint,
} from './fire_weapon_plugin.js';

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

describe('getNextExitpoint', () => {
    // Only the fields getNextExitpoint reads are filled in; the real
    // Animation / WeaponData / MovementState carry a lot more.
    function animation(gun: Array<[number, number, number]>): Animation {
        return {
            exitPoints: {
                ...getDefaultExitPoints(),
                gun,
                upCompress: [100, 100],
                downCompress: [100, 100],
            },
        } as Animation;
    }

    function gunWeapon(firesFromClosestToTarget = false): WeaponData {
        return { exitType: 'gun', firesFromClosestToTarget } as WeaponData;
    }

    function shipAt(position: Position): MovementState {
        return {
            position,
            velocity: new Vector(0, 0),
            rotation: new Angle(0),
            turning: 0,
            turnBack: false,
            accelerating: 0,
        };
    }

    const ORIGIN = new Position(0, 0);
    const TARGET = new Position(1000, 0);

    it('cycles through the exit points, one per shot', () => {
        const source = shipAt(ORIGIN);
        const anim = animation([[20, 0, 0], [-20, 0, 0], [0, -30, 0]]);
        const localState = defaultWeaponLocalState();
        const indices = [];
        for (let i = 0; i < 5; i++) {
            getNextExitpoint(source, anim, gunWeapon(), localState);
            indices.push(localState.exitIndex);
        }
        expect(indices).toEqual([1, 2, 0, 1, 2]);
    });

    it('offsets the shot by the chosen exit point', () => {
        const source = shipAt(ORIGIN);
        const anim = animation([[20, 0, 0], [-20, 0, 0]]);
        const localState = defaultWeaponLocalState();
        // Cursor starts at 0 and advances first, so this is index 1.
        const { exitPoint } = getNextExitpoint(source, anim, gunWeapon(),
            localState);
        expect(exitPoint.x).toBeCloseTo(-20, 12);
        expect(exitPoint.y).toBeCloseTo(0, 12);
    });

    // A shän with no exit points of the weapon's class used to reach
    // `% 0`, writing NaN into exitIndex. That cursor is replicated,
    // wire-serialized state, and NaN does not survive JSON.
    it('leaves the cursor alone when the ship has no exit points', () => {
        const source = shipAt(ORIGIN);
        const anim = animation([]);
        const localState = defaultWeaponLocalState();

        for (let i = 0; i < 3; i++) {
            const { exitPoint } = getNextExitpoint(source, anim, gunWeapon(),
                localState, TARGET);
            // Fires from the ship's centre.
            expect(exitPoint.x).toEqual(0);
            expect(exitPoint.y).toEqual(0);
            expect(localState.exitIndex).not.toBeNaN();
            expect(localState.exitIndex).toEqual(0);
        }
    });

    it('leaves the cursor alone with no exit points and the ' +
        'closest-to-target flag', () => {
            const source = shipAt(ORIGIN);
            const anim = animation([]);
            const localState = defaultWeaponLocalState();
            getNextExitpoint(source, anim, gunWeapon(true), localState, TARGET);
            expect(localState.exitIndex).not.toBeNaN();
        });

    it('does not touch the cursor for a centre-firing weapon', () => {
        const source = shipAt(ORIGIN);
        const anim = animation([[20, 0, 0]]);
        const localState = defaultWeaponLocalState();
        const centerWeapon = { exitType: 'center' } as WeaponData;
        const { exitPoint } = getNextExitpoint(source, anim, centerWeapon,
            localState);
        expect(exitPoint).toBe(source.position);
        expect(localState.exitIndex).toEqual(0);
    });
});
