import 'jasmine';
import { getDefaultGovtData } from 'novadatainterface/govt_data';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState } from 'nova_ecs/plugins/movement_plugin';
import { govtDisposition, effectiveStrength, oddsFavorable } from './govt_disposition.js';
import {
    chooseNearest, formationOffset, formationSlotPosition,
    FORMATION_LATERAL_SPACING, FORMATION_ROW_SPACING, steerFormation,
} from './npc_ai_plugin.js';

function govt(overrides: Partial<ReturnType<typeof getDefaultGovtData>>) {
    return { ...getDefaultGovtData(), ...overrides };
}

describe('govtDisposition', () => {
    const federation = govt({
        id: 'nova:128', classes: [1], allies: [2], enemies: [3],
    });
    const auroran = govt({ id: 'nova:129', classes: [3], enemies: [1] });
    const friend = govt({ id: 'nova:131', classes: [2] });
    const bystander = govt({ id: 'nova:132', classes: [9] });
    const pirates = govt({
        id: 'nova:133', classes: [5], allies: [6],
        flags: { ...getDefaultGovtData().flags, xenophobic: true },
    });
    const pirateFriend = govt({ id: 'nova:134', classes: [6] });

    it('is hostile to govts whose classes intersect its enemies', () => {
        expect(govtDisposition(federation, auroran)).toBe('enemy');
    });

    it('is allied with govts whose classes intersect its allies', () => {
        expect(govtDisposition(federation, friend)).toBe('ally');
    });

    it('is allied with itself', () => {
        expect(govtDisposition(federation, federation)).toBe('ally');
    });

    it('is neutral toward unrelated govts', () => {
        expect(govtDisposition(federation, bystander)).toBe('neutral');
    });

    it('is neutral toward independents by default', () => {
        expect(govtDisposition(federation, undefined)).toBe('neutral');
    });

    it('independent ships have no politics', () => {
        expect(govtDisposition(undefined, federation)).toBe('neutral');
        expect(govtDisposition(undefined, undefined)).toBe('neutral');
    });

    it('xenophobic govts attack everyone except allies', () => {
        expect(govtDisposition(pirates, bystander)).toBe('enemy');
        expect(govtDisposition(pirates, undefined)).toBe('enemy');
        expect(govtDisposition(pirates, pirateFriend)).toBe('ally');
        expect(govtDisposition(pirates, pirates)).toBe('ally');
    });

    it('alwaysAttacksPlayer makes independents enemies', () => {
        const nasty = govt({
            id: 'nova:135', classes: [7],
            flags: {
                ...getDefaultGovtData().flags, alwaysAttacksPlayer: true,
            },
        });
        expect(govtDisposition(nasty, undefined)).toBe('enemy');
        expect(govtDisposition(nasty, bystander)).toBe('neutral');
    });
});

describe('effectiveStrength and oddsFavorable (govt MaxOdds)', () => {
    it('scales strength between 30% and 100% by shields', () => {
        expect(effectiveStrength(100, 1)).toBe(100);
        expect(effectiveStrength(100, 0)).toBeCloseTo(30);
        expect(effectiveStrength(100, 0.5)).toBeCloseTo(65);
        // Clamped outside [0, 1].
        expect(effectiveStrength(100, 2)).toBe(100);
        expect(effectiveStrength(100, -1)).toBeCloseTo(30);
    });

    it('MaxOdds 100 accepts up to a 1-to-1 fight', () => {
        expect(oddsFavorable(100, 50, 50)).toBeTrue();
        expect(oddsFavorable(100, 50, 51)).toBeFalse();
    });

    it('higher MaxOdds accepts worse odds', () => {
        expect(oddsFavorable(300, 50, 150)).toBeTrue();
        expect(oddsFavorable(300, 50, 151)).toBeFalse();
    });

    it('a zero-strength ship never fights', () => {
        expect(oddsFavorable(1000, 0, 1)).toBeFalse();
    });
});

describe('chooseNearest', () => {
    it('picks the nearest candidate', () => {
        expect(chooseNearest([['a', 100], ['b', 25], ['c', 400]])).toBe('b');
    });

    it('breaks exact distance ties by the smaller uuid, regardless of ' +
        'iteration order', () => {
            expect(chooseNearest([['b', 25], ['a', 25]])).toBe('a');
            expect(chooseNearest([['a', 25], ['b', 25]])).toBe('a');
        });

    it('returns undefined for no candidates', () => {
        expect(chooseNearest([])).toBeUndefined();
    });
});

describe('formation geometry', () => {
    it('pairs slots into rows fanning out behind the leader', () => {
        expect(formationOffset(0)).toEqual(
            { back: FORMATION_ROW_SPACING, lateral: FORMATION_LATERAL_SPACING });
        expect(formationOffset(1)).toEqual(
            { back: FORMATION_ROW_SPACING, lateral: -FORMATION_LATERAL_SPACING });
        expect(formationOffset(2)).toEqual({
            back: 2 * FORMATION_ROW_SPACING,
            lateral: 2 * FORMATION_LATERAL_SPACING,
        });
        expect(formationOffset(3)).toEqual({
            back: 2 * FORMATION_ROW_SPACING,
            lateral: -2 * FORMATION_LATERAL_SPACING,
        });
    });

    it('places slots behind a leader facing "up" (angle 0)', () => {
        // Angle 0 is clock-up: unit vector (0, -1). Behind is +y.
        const slot = formationSlotPosition(
            new Position(0, 0), new Angle(0), 0);
        expect(slot.y).toBeCloseTo(FORMATION_ROW_SPACING);
        // Slot 0 sits laterally offset (rotated +90° from facing).
        expect(Math.abs(slot.x)).toBeCloseTo(FORMATION_LATERAL_SPACING);
    });

    it('rotates slot positions with the leader', () => {
        const up = formationSlotPosition(new Position(0, 0), new Angle(0), 0);
        const right = formationSlotPosition(
            new Position(0, 0), new Angle(Math.PI / 2), 0);
        // Rotating the leader 90° rotates the slot 90°.
        expect(right.x).toBeCloseTo(-up.y);
        expect(right.y).toBeCloseTo(up.x);
    });
});

describe('steerFormation', () => {
    function movement(overrides: Partial<MovementState>): MovementState {
        return {
            position: new Position(0, 0),
            velocity: new Vector(0, 0),
            rotation: new Angle(0),
            accelerating: 0,
            turning: 0,
            turnBack: false,
            ...overrides,
        };
    }

    it('thrusts toward a distant slot once facing it', () => {
        const leader = movement({ position: new Position(0, -1000) });
        // The slot is far up (-y); the follower already faces up.
        const follower = movement({ position: new Position(0, 0) });
        steerFormation(follower, leader, 0);
        expect(follower.turnTo instanceof Angle).toBeTrue();
        expect(follower.accelerating).toBe(1);
    });

    it('coasts and aligns with the leader when on station', () => {
        const leader = movement({
            position: new Position(0, 0),
            velocity: new Vector(0, 0),
            rotation: new Angle(1),
        });
        const follower = movement({
            position: formationSlotPosition(
                new Position(0, 0), new Angle(1), 2),
            velocity: new Vector(0, 0),
        });
        steerFormation(follower, leader, 2);
        expect(follower.accelerating).toBe(0);
        expect((follower.turnTo as Angle).angle).toBeCloseTo(1);
    });

    it('matches velocity: a follower in the slot of a moving leader ' +
        'is steered along the leader velocity', () => {
            const leader = movement({
                position: new Position(0, 0),
                velocity: new Vector(200, 0),
                rotation: new Angle(Math.PI / 2),
            });
            const follower = movement({
                position: formationSlotPosition(
                    new Position(0, 0), new Angle(Math.PI / 2), 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(Math.PI / 2),
            });
            steerFormation(follower, leader, 0);
            // Stationary follower, moving leader: the correction points
            // along +x, which is exactly where the follower faces.
            expect(follower.accelerating).toBe(1);
            const heading = follower.turnTo as Angle;
            expect(heading.getUnitVector().x).toBeGreaterThan(0.9);
        });
});
