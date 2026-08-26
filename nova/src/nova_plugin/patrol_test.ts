import 'jasmine';
import {
    nextPatrolWaypoint,
    PATROL_WAYPOINT_ANGLE,
} from './patrol';

describe('patrol waypoint geometry', () => {
    it('advances clockwise when the current nose follows the ring', () => {
        const waypoint = nextPatrolWaypoint(
            [0, 0],
            600,
            [0, -600],
            Math.PI / 2,
        );

        expect(waypoint.direction).toBe(1);
        expect(waypoint.position[0])
            .toBeCloseTo(Math.sin(Math.PI / 3) * 600, 6);
        expect(waypoint.position[1])
            .toBeCloseTo(-Math.cos(Math.PI / 3) * 600, 6);
        expect(waypoint.heading).toBeCloseTo(5 * Math.PI / 6, 6);
    });

    it('advances counterclockwise when the current nose follows that tangent', () => {
        const waypoint = nextPatrolWaypoint(
            [0, 0],
            600,
            [0, -600],
            -Math.PI / 2,
        );

        expect(waypoint.direction).toBe(-1);
        expect(waypoint.position[0])
            .toBeCloseTo(-Math.sin(Math.PI / 3) * 600, 6);
        expect(waypoint.position[1])
            .toBeCloseTo(-Math.cos(Math.PI / 3) * 600, 6);
        expect(waypoint.heading).toBeCloseTo(-5 * Math.PI / 6, 6);
    });

    it('retains an explicit direction while choosing the next point', () => {
        const waypoint = nextPatrolWaypoint(
            [100, 200],
            300,
            [100, -100],
            Math.PI / 2,
            { direction: -1, angularStep: Math.PI / 2 },
        );

        expect(waypoint.direction).toBe(-1);
        expect(waypoint.position[0]).toBeCloseTo(-200, 6);
        expect(waypoint.position[1]).toBeCloseTo(200, 6);
        expect(waypoint.heading).toBeCloseTo(-Math.PI, 6);
    });

    it('keeps every waypoint at the requested radius from the post', () => {
        const waypoint = nextPatrolWaypoint(
            [240, -80],
            725,
            [700, 400],
            0.3,
        );
        const distance = Math.hypot(
            waypoint.position[0] - 240,
            waypoint.position[1] + 80,
        );

        expect(distance).toBeCloseTo(725, 6);
    });

    it('uses the heading to choose a tangent when starting at the post', () => {
        const waypoint = nextPatrolWaypoint(
            [50, 75],
            400,
            [50, 75],
            0,
            { angularStep: 0 },
        );

        // Heading zero is north; the clockwise tangent at the left point is
        // north, so the degenerate start has a deterministic anchor.
        expect(waypoint.position[0]).toBeCloseTo(50 - 400, 6);
        expect(waypoint.position[1]).toBeCloseTo(75, 6);
        expect(waypoint.heading).toBeCloseTo(0, 6);
    });

    it('completes a circuit after six equal angular advances', () => {
        let position: readonly [number, number] = [0, -500];
        let heading = Math.PI / 2;
        let direction: -1 | 1 = 1;

        for (let index = 0; index < 6; index++) {
            const waypoint = nextPatrolWaypoint(
                [0, 0],
                500,
                position,
                heading,
                { direction },
            );
            position = waypoint.position;
            heading = waypoint.heading;
            direction = waypoint.direction;
        }

        expect(PATROL_WAYPOINT_ANGLE).toBeCloseTo(Math.PI / 3, 6);
        expect(position[0]).toBeCloseTo(0, 6);
        expect(position[1]).toBeCloseTo(-500, 6);
        expect(heading).toBeCloseTo(Math.PI / 2, 6);
    });
});
