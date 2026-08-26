/**
 * Steering for ships that have to arrive somewhere, rather than merely charge
 * at it.
 *
 * Nova's ships are Newtonian: thrust only pushes along the nose, turning takes
 * time, and nothing brakes on its own. An AI that points at its target and
 * holds full throttle therefore overshoots, sails past, turns around, and
 * overshoots again. That is what mining ships were doing.
 *
 * The fix is velocity matching. At every step the controller works out the
 * velocity it *wants* — pointing at the target, at a speed it can still shed
 * before arriving — and thrusts along the difference between that and its
 * current velocity. Coasting while the nose is still swinging keeps thrust
 * from being spent in the wrong direction, which is what makes an approach
 * look deliberate.
 */

import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';

export interface FlightSituation {
    position: Position;
    velocity: Vector;
    rotation: Angle;
}

export interface FlightLimits {
    /** Engine units per second squared. */
    acceleration: number;
    maxVelocity: number;
    /**
     * Radians per second. Braking costs a turn as well as a burn, so a
     * sluggish hull has to slow down earlier than a nimble one.
     */
    turnRate: number;
}

export interface FlightTarget {
    position: Position;
    /** A moving target is matched, not just chased. */
    velocity?: Vector;
}

export interface ApproachOptions {
    /**
     * How far from the target to come to rest. Weapons keep firing at the
     * target regardless of heading, so standing off is free.
     */
    standoff: number;
    /** Extra slack so a ship does not fidget once it is close enough. */
    tolerance?: number;
    /**
     * Fraction of the theoretically perfect braking speed to aim for. Below
     * one leaves room for the turn that braking needs.
     */
    caution?: number;
    /**
     * Thrust is withheld while the nose is further than this from the
     * direction the ship wants to push, in radians.
     */
    thrustCone?: number;
}

export interface FlightCommand {
    /** Absolute heading to turn to, or null to hold the current heading. */
    turnTo: Angle | null;
    /** Throttle from 0 to 1. */
    accelerating: number;
    /** Ask the movement system to swing the nose onto reverse thrust. */
    turnBack: boolean;
}

export const DEFAULT_CAUTION = 0.95;
export const DEFAULT_THRUST_CONE = Math.PI / 4;
export const DEFAULT_TOLERANCE = 0.15;

/**
 * The distance needed to shed a speed at a given acceleration. This is the
 * quantity a charging AI ignores, and the reason it overshoots.
 */
export function stoppingDistance(speed: number, acceleration: number): number {
    if (!(acceleration > 0) || speed <= 0) {
        return 0;
    }
    return speed * speed / (2 * acceleration);
}

/**
 * How long it takes to swing the nose right around, which is what braking
 * costs before the engine can help at all.
 */
export function turnaroundTime(turnRate: number): number {
    return turnRate > 0 ? Math.PI / turnRate : 0;
}

/**
 * The fastest a ship may travel and still come to rest within a distance.
 *
 * Naively this is `stoppingDistance` solved for speed, but a ship cannot brake
 * until it has turned around, and it keeps coasting while it turns. Including
 * that coast is the difference between an approach that settles and one that
 * sails past and has to come back: solving
 * `distance = v^2 / 2a + v * turnaround` for v gives the speed below.
 */
export function arrivalSpeed(
    distance: number,
    limits: FlightLimits,
    caution = DEFAULT_CAUTION,
): number {
    const { acceleration, maxVelocity } = limits;
    if (distance <= 0 || !(acceleration > 0)) {
        return 0;
    }
    const coast = acceleration * turnaroundTime(limits.turnRate);
    const solved = Math.sqrt(coast * coast + 2 * acceleration * distance)
        - coast;
    return Math.min(
        maxVelocity, solved * Math.max(0, Math.min(1, caution)));
}

/**
 * Nova's headings run clockwise from straight up: a heading's unit vector is
 * `(sin, -cos)`, so recovering a heading from a vector is `atan2(x, -y)` and
 * not the usual `atan2(y, x)`.
 */
function angleOf(vector: Vector): Angle {
    return new Angle(Math.atan2(vector.x, -vector.y));
}

/** Smallest signed turn from one heading to another, in radians. */
export function headingError(from: Angle, to: Angle): number {
    return new Angle(to.angle - from.angle).angle;
}

/**
 * Steer towards a standoff distance from a target and stop there.
 *
 * The returned command is meant to be written straight onto a ship's movement
 * state each step; it is a controller, not a plan, so it recovers naturally
 * from being knocked off course.
 */
export function approachTarget(
    self: FlightSituation,
    target: FlightTarget,
    limits: FlightLimits,
    options: ApproachOptions,
): FlightCommand {
    const caution = options.caution ?? DEFAULT_CAUTION;
    const thrustCone = options.thrustCone ?? DEFAULT_THRUST_CONE;
    const tolerance = options.tolerance
        ?? Math.max(1, options.standoff * DEFAULT_TOLERANCE);

    const toTarget = target.position.subtract(self.position);
    const distance = toTarget.length;
    const targetVelocity = target.velocity ?? new Vector(0, 0);

    // Aim at a point short of the target rather than the target itself, so
    // arriving and standing off are the same manoeuvre.
    const remaining = distance - options.standoff;
    const direction = distance > 0
        ? toTarget.normalize(1)
        : new Vector(1, 0);

    const speed = arrivalSpeed(Math.max(0, remaining), limits, caution);
    // Overshooting means wanting to travel back the way we came.
    const desiredVelocity = remaining >= 0
        ? direction.scale(speed).add(targetVelocity)
        : direction.scale(-arrivalSpeed(-remaining, limits, caution))
            .add(targetVelocity);

    const correction = desiredVelocity.subtract(self.velocity);
    const correctionSpeed = correction.length;

    // Close enough, and slow enough, to simply hold station.
    const settled = Math.abs(remaining) <= tolerance
        && correctionSpeed <= limits.acceleration * 0.25;
    if (settled) {
        return { turnTo: null, accelerating: 0, turnBack: false };
    }

    const heading = angleOf(correction);
    const error = Math.abs(headingError(self.rotation, heading));
    return {
        turnTo: heading,
        // Thrust only once the nose is roughly where the push is wanted.
        // Otherwise the ship would accelerate sideways while turning.
        accelerating: error <= thrustCone ? 1 : 0,
        turnBack: false,
    };
}

/**
 * Whether a ship is parked at its standoff distance. Callers use this to
 * decide that a transfer may happen, or that mining may start.
 */
export function hasArrived(
    self: FlightSituation,
    target: FlightTarget,
    options: { standoff: number, tolerance?: number, maxSpeed?: number },
): boolean {
    const tolerance = options.tolerance
        ?? Math.max(1, options.standoff * DEFAULT_TOLERANCE);
    const distance = target.position.subtract(self.position).length;
    if (distance > options.standoff + tolerance) {
        return false;
    }
    if (options.maxSpeed === undefined) {
        return true;
    }
    const relative = self.velocity
        .subtract(target.velocity ?? new Vector(0, 0));
    return relative.length <= options.maxSpeed;
}

/**
 * Whether a ship is close enough to hand something over — fuel to a stranded
 * pilot, or a boarding party to a disabled hull.
 */
export function inTransferRange(
    self: FlightSituation,
    target: FlightTarget,
    range: number,
): boolean {
    return target.position.subtract(self.position).length <= range;
}
