/**
 * Geometry for a ship that keeps circling a stellar.
 *
 * This module deliberately knows nothing about ECS. A waypoint is a point on
 * the guard ring, so the normal flight controller can handle acceleration,
 * turning, and recovery after an interruption.
 */

export type PatrolPoint = readonly [number, number];
export type PatrolDirection = -1 | 1;

export interface PatrolWaypoint {
    position: [number, number];
    /** Nova heading tangent to the ring at the waypoint. */
    heading: number;
    /** Positive follows increasing Nova bearings; negative goes the other way. */
    direction: PatrolDirection;
    angle: number;
}

export interface PatrolWaypointOptions {
    direction?: PatrolDirection;
    angularStep?: number;
}

/** Six waypoints per circuit keeps the path visibly orbital without tight turns. */
export const PATROL_WAYPOINT_ANGLE = Math.PI / 3;

function finite(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
}

function normalizeAngle(angle: number): number {
    const wrapped = ((angle % (2 * Math.PI)) + 2 * Math.PI)
        % (2 * Math.PI);
    return wrapped >= Math.PI ? wrapped - 2 * Math.PI : wrapped;
}

function angleAt(
    guardPost: PatrolPoint,
    currentPosition: PatrolPoint,
    currentHeading: number,
): number {
    const x = finite(currentPosition[0], 0)
        - finite(guardPost[0], 0);
    const y = finite(currentPosition[1], 0)
        - finite(guardPost[1], 0);
    if (Math.hypot(x, y) < Number.EPSILON) {
        // At the centre there is no radial bearing. This anchor makes the
        // current nose tangent to the first clockwise point on the ring.
        return normalizeAngle(finite(currentHeading, 0) - Math.PI / 2);
    }
    return normalizeAngle(Math.atan2(x, -y));
}

function inferredDirection(
    angle: number,
    currentHeading: number,
): PatrolDirection {
    const heading = finite(currentHeading, 0);
    const headingX = Math.sin(heading);
    const headingY = -Math.cos(heading);
    // Increasing Nova bearings have tangent (cos(angle), sin(angle)).
    const clockwiseDot = headingX * Math.cos(angle)
        + headingY * Math.sin(angle);
    return clockwiseDot >= 0 ? 1 : -1;
}

/**
 * Pick the next point on a patrol ring.
 *
 * When no direction is supplied, the ship's current nose chooses the
 * direction whose tangent it is already closest to. Callers that retain the
 * returned direction can keep a circuit stable while the ship is turning
 * toward each successive waypoint.
 */
export function nextPatrolWaypoint(
    guardPost: PatrolPoint,
    radius: number,
    currentPosition: PatrolPoint,
    currentHeading: number,
    options: PatrolWaypointOptions = {},
): PatrolWaypoint {
    const currentAngle = angleAt(
        guardPost, currentPosition, currentHeading);
    const direction = options.direction === -1 || options.direction === 1
        ? options.direction
        : inferredDirection(currentAngle, currentHeading);
    const configuredStep = finite(
        options.angularStep ?? PATROL_WAYPOINT_ANGLE,
        PATROL_WAYPOINT_ANGLE,
    );
    const step = Math.max(0, Math.min(2 * Math.PI, configuredStep));
    const angle = normalizeAngle(currentAngle + direction * step);
    const centerX = finite(guardPost[0], 0);
    const centerY = finite(guardPost[1], 0);
    const safeRadius = Math.max(0, finite(radius, 0));

    return {
        position: [
            centerX + Math.sin(angle) * safeRadius,
            centerY - Math.cos(angle) * safeRadius,
        ],
        heading: normalizeAngle(angle + direction * Math.PI / 2),
        direction,
        angle,
    };
}
