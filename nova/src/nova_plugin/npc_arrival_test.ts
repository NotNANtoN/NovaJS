import 'jasmine';
import {
    chooseArrivalPlacement,
    headingTowards,
    HYPERSPACE_ENTRY_RADIUS,
    hyperspaceEntry,
    stellarLaunch,
    STELLAR_LAUNCH_OFFSET,
} from './npc_arrival';
import { JUMP_ARRIVAL_RADIUS } from './jump_plugin';
import {
    MULTIPLAYER_INTEREST_RADIUS,
} from 'nova_ecs/plugins/multiplayer_plugin';

/** Feeds a fixed sequence, so every branch is deterministic. */
function rolls(...values: number[]): () => number {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)];
}

const SYSTEM = {
    position: [0, 0] as const,
    links: ['north', 'east'],
    planets: ['p1'],
};

const NEIGHBOURS = new Map<string, readonly [number, number]>([
    // Galaxy maps put north at a smaller y, as on screen.
    ['north', [0, -100]],
    ['east', [100, 0]],
]);

describe('heading between two points', () => {
    it('measures from straight up, turning clockwise', () => {
        expect(headingTowards([0, 0], [0, -10])).toBeCloseTo(0, 6);
        expect(headingTowards([0, 0], [10, 0])).toBeCloseTo(Math.PI / 2, 6);
        expect(headingTowards([0, 0], [0, 10])).toBeCloseTo(Math.PI, 6);
    });
});

describe('arriving from hyperspace', () => {
    it('uses the player arrival scale well inside multiplayer interest', () => {
        expect(HYPERSPACE_ENTRY_RADIUS).toBe(JUMP_ARRIVAL_RADIUS);

        const placement = hyperspaceEntry(SYSTEM, NEIGHBOURS, rolls(0))!;
        const distance = Math.hypot(
            placement.position[0], placement.position[1]);

        expect(distance).toBeCloseTo(JUMP_ARRIVAL_RADIUS, 6);
        expect(distance).toBeLessThan(MULTIPLAYER_INTEREST_RADIUS / 2);
    });

    it('appears on the side facing the system it came from', () => {
        const placement = hyperspaceEntry(SYSTEM, NEIGHBOURS, rolls(0))!;
        // The first link is north, so the ship drops in above the system.
        expect(placement.position[0]).toBeCloseTo(0, 6);
        expect(placement.position[1]).toBeCloseTo(-HYPERSPACE_ENTRY_RADIUS, 6);
        expect(placement.origin).toEqual('hyperspace');
    });

    it('faces inward, back towards the system it is entering', () => {
        const placement = hyperspaceEntry(SYSTEM, NEIGHBOURS, rolls(0))!;
        // Arriving from the north means heading south, a half turn from zero.
        expect(placement.rotation).toBeCloseTo(Math.PI, 6);
    });

    it('uses the neighbour the roll selected', () => {
        const placement = hyperspaceEntry(SYSTEM, NEIGHBOURS, rolls(0.9))!;
        expect(placement.position[0]).toBeCloseTo(HYPERSPACE_ENTRY_RADIUS, 6);
        expect(placement.position[1]).toBeCloseTo(0, 6);
    });

    it('still arrives at the edge when no neighbour can be mapped', () => {
        const placement = hyperspaceEntry(
            { position: [0, 0], links: ['unknown'], planets: [] },
            new Map(),
            rolls(0))!;
        const distance = Math.hypot(
            placement.position[0], placement.position[1]);
        expect(distance).toBeCloseTo(HYPERSPACE_ENTRY_RADIUS, 6);
    });
});

describe('lifting off from a stellar', () => {
    it('appears just off the stellar, heading away from it', () => {
        expect(STELLAR_LAUNCH_OFFSET).toBe(700);

        const placement = stellarLaunch([500, 500], rolls(0));
        expect(placement.position[0]).toBeCloseTo(500, 6);
        expect(placement.position[1])
            .toBeCloseTo(500 - STELLAR_LAUNCH_OFFSET, 6);
        expect(Math.hypot(
            placement.position[0] - 500,
            placement.position[1] - 500,
        )).toBeCloseTo(STELLAR_LAUNCH_OFFSET, 6);
        expect(placement.rotation).toBeCloseTo(0, 6);
        expect(placement.origin).toEqual('stellar');
    });
});

describe('choosing how a ship enters', () => {
    it('uses the deliberate local-launch share by default', () => {
        const local = chooseArrivalPlacement(
            SYSTEM, NEIGHBOURS, [[500, 500]], rolls(0.69, 0, 0))!;
        const edge = chooseArrivalPlacement(
            SYSTEM, NEIGHBOURS, [[500, 500]], rolls(0.7, 0))!;

        expect(local.origin).toEqual('stellar');
        expect(edge.origin).toEqual('hyperspace');
    });

    it('lifts off from a stellar when the roll falls below the share', () => {
        const placement = chooseArrivalPlacement(
            SYSTEM, NEIGHBOURS, [[500, 500]], rolls(0.1, 0, 0), 0.5)!;
        expect(placement.origin).toEqual('stellar');
    });

    it('arrives from hyperspace when the roll falls above the share', () => {
        const placement = chooseArrivalPlacement(
            SYSTEM, NEIGHBOURS, [[500, 500]], rolls(0.9, 0), 0.5)!;
        expect(placement.origin).toEqual('hyperspace');
    });

    it('prefers candidates explicitly marked as inhabited', () => {
        const placement = chooseArrivalPlacement(
            SYSTEM,
            NEIGHBOURS,
            [
                { position: [900, 900], inhabited: false },
                { position: [500, 500], inhabited: true },
            ],
            rolls(0.1, 0, 0),
            0.5,
        )!;

        expect(placement.origin).toEqual('stellar');
        expect(placement.position[0]).toBeCloseTo(500, 6);
        expect(placement.position[1])
            .toBeCloseTo(500 - STELLAR_LAUNCH_OFFSET, 6);
    });

    it('uses hyperspace when metadata says every stellar is barren', () => {
        const placement = chooseArrivalPlacement(
            SYSTEM,
            NEIGHBOURS,
            [{ position: [500, 500], inhabited: false }],
            rolls(0.1, 0, 0),
            0.5,
        )!;

        expect(placement.origin).toEqual('hyperspace');
    });

    it('falls back to hyperspace in a system of bare rocks', () => {
        const placement = chooseArrivalPlacement(
            SYSTEM, NEIGHBOURS, [], rolls(0.1, 0), 0.5)!;
        expect(placement.origin).toEqual('hyperspace');
    });

    it('never places a ship at the origin the way spawning used to', () => {
        for (let roll = 0; roll < 1; roll += 0.1) {
            const placement = chooseArrivalPlacement(
                SYSTEM, NEIGHBOURS, [[500, 500]], rolls(roll), 0.5)!;
            const distance = Math.hypot(
                placement.position[0], placement.position[1]);
            expect(distance).toBeGreaterThan(100);
        }
    });
});
