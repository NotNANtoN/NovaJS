import 'jasmine';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import {
    approachTarget,
    arrivalSpeed,
    FlightLimits,
    FlightSituation,
    hasArrived,
    headingError,
    inTransferRange,
    stoppingDistance,
} from './flight_controller';

const LIMITS: FlightLimits = { acceleration: 200, maxVelocity: 400, turnRate: 3 };
const STEP = 1 / 60;

/**
 * Fly a ship under the controller using the same integration the movement
 * plugin uses: thrust along the nose, a capped turn rate, and no free braking.
 * This is the only honest way to show that an approach converges.
 */
function fly(
    self: FlightSituation,
    target: { position: Position, velocity?: Vector },
    options: { standoff: number, turnRate?: number, steps?: number },
) {
    const turnRate = options.turnRate ?? LIMITS.turnRate;
    const limits = { ...LIMITS, turnRate };
    const steps = options.steps ?? 3_000;
    let closest = Infinity;
    let position = self.position;
    let velocity = self.velocity;
    let rotation = self.rotation;
    let targetPosition = target.position;

    for (let step = 0; step < steps; step++) {
        const situation = { position, velocity, rotation };
        const command = approachTarget(
            situation, { position: targetPosition, velocity: target.velocity },
            limits, { standoff: options.standoff });

        if (command.turnTo) {
            const error = headingError(rotation, command.turnTo);
            const turn = Math.sign(error)
                * Math.min(Math.abs(error), turnRate * STEP);
            rotation = new Angle(rotation.angle + turn);
        }
        if (command.accelerating > 0) {
            velocity = velocity.add(rotation.getUnitVector()
                .normalize(command.accelerating * limits.acceleration * STEP));
        }
        velocity = velocity.shortenToLength(limits.maxVelocity);
        position = position.add(velocity.scale(STEP)) as Position;
        if (target.velocity) {
            targetPosition = targetPosition
                .add(target.velocity.scale(STEP)) as Position;
        }
        closest = Math.min(
            closest, targetPosition.subtract(position).length);
    }

    return {
        distance: targetPosition.subtract(position).length,
        speed: velocity.subtract(target.velocity ?? new Vector(0, 0)).length,
        closest,
        situation: { position, velocity, rotation },
        targetPosition,
    };
}

function still(x: number, y: number): FlightSituation {
    return {
        position: new Position(x, y),
        velocity: new Vector(0, 0),
        rotation: new Angle(0),
    };
}

describe('braking arithmetic', () => {
    it('knows how far it takes to stop', () => {
        expect(stoppingDistance(200, 200)).toBeCloseTo(100, 5);
        expect(stoppingDistance(0, 200)).toBe(0);
        expect(stoppingDistance(200, 0)).toBe(0);
    });

    it('inverts that into a speed it can still shed', () => {
        // With no turn to pay for, this is stoppingDistance solved for speed:
        // 100 units at 200 u/s^2 is 200 u/s.
        const nimble = { acceleration: 200, maxVelocity: 400, turnRate: 1e6 };
        expect(arrivalSpeed(100, nimble, 1)).toBeCloseTo(200, 2);
        expect(arrivalSpeed(0, nimble)).toBe(0);
    });

    it('makes a sluggish hull slow down earlier than a nimble one', () => {
        const nimble = { acceleration: 200, maxVelocity: 400, turnRate: 6 };
        const sluggish = { acceleration: 200, maxVelocity: 400, turnRate: 0.8 };
        expect(arrivalSpeed(400, sluggish, 1))
            .toBeLessThan(arrivalSpeed(400, nimble, 1));
    });

    it('never asks for more than the hull can do', () => {
        expect(arrivalSpeed(1e9, LIMITS, 1)).toBe(400);
    });
});

describe('heading error', () => {
    it('takes the short way round', () => {
        expect(headingError(new Angle(0), new Angle(0.1))).toBeCloseTo(0.1, 6);
        const wrapped = headingError(
            new Angle(-Math.PI + 0.05), new Angle(Math.PI - 0.05));
        expect(Math.abs(wrapped)).toBeCloseTo(0.1, 6);
    });
});

describe('approaching a rock', () => {
    it('arrives at the standoff distance and stays there', () => {
        const result = fly(still(-2_000, 0), { position: new Position(0, 0) },
            { standoff: 400 });
        expect(result.distance).toBeGreaterThan(300);
        expect(result.distance).toBeLessThan(500);
        expect(result.speed).toBeLessThan(20);
    });

    it('does not barge through what it is approaching', () => {
        const result = fly(still(-2_000, 0), { position: new Position(0, 0) },
            { standoff: 400 });
        // A charging AI's telltale is sailing right past its target.
        expect(result.closest).toBeGreaterThan(250);
    });

    it('settles even from a bad angle with a sluggish hull', () => {
        const result = fly(
            {
                position: new Position(1_500, -1_500),
                velocity: new Vector(300, 0),
                rotation: new Angle(Math.PI),
            },
            { position: new Position(0, 0) },
            { standoff: 400, turnRate: 1.2 });
        expect(result.distance).toBeGreaterThan(250);
        expect(result.distance).toBeLessThan(600);
        expect(result.speed).toBeLessThan(40);
    });

    it('matches a drifting target instead of chasing its wake', () => {
        const result = fly(still(-2_000, 0), {
            position: new Position(0, 0),
            velocity: new Vector(30, 10),
        }, { standoff: 300 });
        expect(result.distance).toBeLessThan(500);
        expect(result.speed).toBeLessThan(30);
    });

    it('closes right up when asked to touch', () => {
        const result = fly(still(-800, 0), { position: new Position(0, 0) },
            { standoff: 0 });
        expect(result.distance).toBeLessThan(60);
    });
});

describe('knowing it has arrived', () => {
    const target = { position: new Position(0, 0) };

    it('is not fooled by flying past at speed', () => {
        expect(hasArrived({
            position: new Position(100, 0),
            velocity: new Vector(400, 0),
            rotation: new Angle(0),
        }, target, { standoff: 100, maxSpeed: 30 })).toBeFalse();
    });

    it('accepts sitting still at the right distance', () => {
        expect(hasArrived(still(100, 0), target,
            { standoff: 100, maxSpeed: 30 })).toBeTrue();
    });

    it('rejects being too far out', () => {
        expect(hasArrived(still(900, 0), target,
            { standoff: 100 })).toBeFalse();
    });
});

describe('transfer range', () => {
    it('is a plain distance check', () => {
        const target = { position: new Position(0, 0) };
        expect(inTransferRange(still(50, 0), target, 60)).toBeTrue();
        expect(inTransferRange(still(70, 0), target, 60)).toBeFalse();
    });
});
