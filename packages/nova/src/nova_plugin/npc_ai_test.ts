import 'jasmine';
import { getDefaultGovtData } from 'novadatainterface/govt_data';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState } from 'nova_ecs/plugins/movement_plugin';
import { govtDisposition, effectiveStrength, oddsFavorable } from './govt_disposition.js';
import {
    chooseNearest, Formation, formationOffset, formationSlotPosition,
    FORMATION_LATERAL_SPACING, FORMATION_ROW_SPACING,
    RCS_ACCEL_FRACTION, RCS_DISENGAGE_SPEED, RCS_ENGAGE_SPEED,
    steerFormation,
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
    const ACCEL = 200;
    const DT = 1 / 60;

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

    function formation(overrides: Partial<Formation> = {}): Formation {
        return { leader: 'leader', slot: 0, ...overrides };
    }

    it('thrusts toward a distant slot once facing it (turn-and-burn)', () => {
        const leader = movement({ position: new Position(0, -1000) });
        // The slot is far up (-y); the follower already faces up.
        const follower = movement({ position: new Position(0, 0) });
        const state = formation();
        steerFormation(follower, leader, state, ACCEL, DT);
        expect(state.rcs ?? false).toBeFalse();
        expect(follower.turnTo instanceof Angle).toBeTrue();
        expect(follower.accelerating).toBe(1);
    });

    it('station-keeps on RCS when on station: heading pinned to the ' +
        'leader, engine dark', () => {
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
            const state = formation({ slot: 2 });
            steerFormation(follower, leader, state, ACCEL, DT);
            expect(state.rcs).toBeTrue();
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
            const state = formation();
            steerFormation(follower, leader, state, ACCEL, DT);
            // Stationary follower, moving leader: the correction points
            // along +x, which is exactly where the follower faces.
            expect(follower.accelerating).toBe(1);
            const heading = follower.turnTo as Angle;
            expect(heading.getUnitVector().x).toBeGreaterThan(0.9);
        });

    it('RCS nudges velocity without rotating and within the budget', () => {
        const leader = movement({
            velocity: new Vector(30, 0),
            rotation: new Angle(0.5),
        });
        // Exactly in the (lookahead-led) slot but 30 px/s slow: the
        // correction is purely velocity, under RCS_ENGAGE_SPEED.
        const follower = movement({
            position: formationSlotPosition(
                new Position(0, 0), new Angle(0.5), 0)
                .add(new Vector(30 * 0.4, 0)) as Position,
            velocity: new Vector(0, 0),
            rotation: new Angle(2),
        });
        const state = formation();
        steerFormation(follower, leader, state, ACCEL, DT);
        expect(state.rcs).toBeTrue();
        // Velocity moved toward the leader's, capped by the budget.
        const budget = ACCEL * RCS_ACCEL_FRACTION * DT;
        expect(follower.velocity.length).toBeGreaterThan(0);
        expect(follower.velocity.length).toBeLessThanOrEqual(budget + 1e-9);
        // No rotation request except aligning with the leader, no
        // engine.
        expect(follower.accelerating).toBe(0);
        expect((follower.turnTo as Angle).angle).toBeCloseTo(0.5);
        expect(follower.turning).toBe(0);
    });

    it('converges on station under RCS with the heading never leaving ' +
        'the leader alignment', () => {
            const leader = movement({
                velocity: new Vector(40, 0),
                rotation: new Angle(Math.PI / 2),
            });
            const slot = formationSlotPosition(
                new Position(0, 0), new Angle(Math.PI / 2), 0);
            // Slightly off station and slow — a correction well under
            // the RCS engage threshold.
            const follower = movement({
                position: new Position(slot.x - 8, slot.y + 6),
                velocity: new Vector(30, 0),
                rotation: new Angle(Math.PI / 2),
            });
            const state = formation();
            // The controller's station point: the slot, led by the
            // leader's velocity (FORMATION_LOOKAHEAD_S = 0.4).
            const error = () => formationSlotPosition(
                Position.fromVectorLike(leader.position),
                Angle.fromAngleLike(leader.rotation), 0)
                .add(Vector.fromVectorLike(leader.velocity).scale(0.4))
                .subtract(follower.position).length;
            const initialError = error();
            for (let i = 0; i < 600; i++) {
                steerFormation(follower, leader, state, ACCEL, DT);
                expect(state.rcs).toBeTrue();
                // RCS never asks for rotation away from the leader.
                expect((follower.turnTo as Angle).angle)
                    .toBeCloseTo(Math.PI / 2);
                expect(follower.accelerating).toBe(0);
                // Integrate: both drift; the follower closes the gap.
                follower.position = follower.position
                    .add(follower.velocity.scale(DT)) as Position;
                leader.position = leader.position
                    .add(leader.velocity.scale(DT)) as Position;
            }
            expect(error()).toBeLessThan(2);
            expect(error()).toBeLessThan(initialError);
            expect(follower.velocity.subtract(leader.velocity).length)
                .toBeLessThan(1);
        });

    it('hysteresis: holds the current regime between the thresholds', () => {
        const midpoint = (RCS_ENGAGE_SPEED + RCS_DISENGAGE_SPEED) / 2;
        const leader = movement({ rotation: new Angle(0) });
        // In slot with a pure velocity mismatch of exactly `midpoint`.
        const follower = () => movement({
            position: formationSlotPosition(
                new Position(0, 0), new Angle(0), 0),
            velocity: new Vector(-midpoint, 0),
            rotation: new Angle(0),
        });
        const fromRcs = formation({ rcs: true });
        steerFormation(follower(), leader, fromRcs, ACCEL, DT);
        expect(fromRcs.rcs).toBeTrue();
        const fromBurn = formation({ rcs: false });
        steerFormation(follower(), leader, fromBurn, ACCEL, DT);
        expect(fromBurn.rcs).toBeFalse();
    });

    it('hysteresis: drops RCS above the disengage threshold and ' +
        'engages below the engage threshold', () => {
            const leader = movement({ rotation: new Angle(0) });
            const withMismatch = (speed: number) => movement({
                position: formationSlotPosition(
                    new Position(0, 0), new Angle(0), 0),
                velocity: new Vector(-speed, 0),
                rotation: new Angle(0),
            });
            const state = formation({ rcs: true });
            steerFormation(withMismatch(RCS_DISENGAGE_SPEED + 10),
                leader, state, ACCEL, DT);
            expect(state.rcs).toBeFalse();
            steerFormation(withMismatch(RCS_ENGAGE_SPEED - 10),
                leader, state, ACCEL, DT);
            expect(state.rcs).toBeTrue();
        });
});
