import 'jasmine';
import {
    JUMP_ARRIVAL_END_SPEED_MULTIPLIER,
    JUMP_ARRIVAL_MS,
    JUMP_ARRIVAL_SPEED_MULTIPLIER,
    JUMP_BAM_MS,
    JUMP_DEPARTURE_SPEED_MULTIPLIER,
    JUMP_SPOOL_MS,
    JumpStateComponent,
    applyJumpFlightMovement,
    calculateJumpArrival,
    cancelJumpFlight,
    consumeCompletedHop,
    isCurrentRouteHop,
    isValidNextHop,
    jumpFlightSpeed,
    pendingJumpTransition,
    routeChangeCancelsJump,
} from './jump_plugin';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Entity } from 'nova_ecs/entity';
import {
    MovementState,
    RemoteMovementPresentationComponent,
} from 'nova_ecs/plugins/movement_plugin';

describe('hyperjump lifecycle', () => {
    it('spools, performs the departure BAM, then holds arrival controls', () => {
        const spooling = {
            phase: 'spooling' as const,
            transitionAt: JUMP_SPOOL_MS,
        };
        expect(pendingJumpTransition(spooling, JUMP_SPOOL_MS - 1))
            .toBe('none');
        expect(pendingJumpTransition(spooling, JUMP_SPOOL_MS))
            .toBe('begin-departure');

        const departing = {
            phase: 'departing' as const,
            transitionAt: JUMP_SPOOL_MS + JUMP_BAM_MS,
        };
        expect(pendingJumpTransition(
            departing, departing.transitionAt - 1)).toBe('none');
        expect(pendingJumpTransition(
            departing, departing.transitionAt)).toBe('transfer');

        const arriving = {
            phase: 'arriving' as const,
            transitionAt: departing.transitionAt + JUMP_ARRIVAL_MS,
        };
        expect(pendingJumpTransition(
            arriving, arriving.transitionAt - 1)).toBe('none');
        expect(pendingJumpTransition(
            arriving, arriving.transitionAt)).toBe('finish-arrival');
    });

    it('consumes exactly the completed route hop', () => {
        const route = ['b', 'c', 'd'];
        expect(consumeCompletedHop(route, 'b')).toEqual(['c', 'd']);
        expect(consumeCompletedHop(route, 'c')).toEqual(route);
        expect(route).toEqual(['b', 'c', 'd']);
        expect(isCurrentRouteHop(route, 'b')).toBeTrue();
        expect(isCurrentRouteHop(['c', 'd'], 'b'))
            .withContext('a route change invalidates an in-progress old hop')
            .toBeFalse();
        expect(routeChangeCancelsJump({
            phase: 'spooling',
            requiresAdjacency: true,
            to: 'b',
        }, ['c', 'd'])).toBeTrue();
        expect(routeChangeCancelsJump({
            phase: 'arriving',
            requiresAdjacency: true,
            to: 'b',
        }, ['c', 'd']))
            .withContext('consuming the completed hop must not cancel arrival')
            .toBeFalse();
    });

    it('accepts only an adjacent first route segment', () => {
        const current = { links: ['b', 'c'] };
        expect(isValidNextHop(current, 'b')).toBeTrue();
        expect(isValidNextHop(current, 'd')).toBeFalse();
        expect(isValidNextHop(undefined, 'b')).toBeFalse();
    });

    it('ramps departure above cruise and eases arrival back down', () => {
        const maxVelocity = 40;
        expect(jumpFlightSpeed('spooling', 0, maxVelocity))
            .toBeCloseTo(18, 8);
        expect(jumpFlightSpeed('spooling', JUMP_SPOOL_MS, maxVelocity))
            .toBeCloseTo(
                maxVelocity * JUMP_DEPARTURE_SPEED_MULTIPLIER, 8);
        expect(jumpFlightSpeed('departing', 0, maxVelocity))
            .toBeCloseTo(
                maxVelocity * JUMP_DEPARTURE_SPEED_MULTIPLIER, 8);
        expect(jumpFlightSpeed('arriving', 0, maxVelocity))
            .toBeCloseTo(
                maxVelocity * JUMP_ARRIVAL_SPEED_MULTIPLIER, 8);
        expect(jumpFlightSpeed(
            'arriving', JUMP_ARRIVAL_MS, maxVelocity,
        )).toBeCloseTo(
            maxVelocity * JUMP_ARRIVAL_END_SPEED_MULTIPLIER, 8);
        expect(jumpFlightSpeed(
            'arriving', JUMP_ARRIVAL_MS / 2, maxVelocity,
        )).toBeLessThan(
            jumpFlightSpeed('arriving', 0, maxVelocity));
    });

    it('corrects normal movement integration and locks held controls', () => {
        const movement: MovementState = {
            position: new Position(1, 0),
            velocity: new Vector(10, 0),
            rotation: new Angle(Math.PI),
            turning: -1,
            turnBack: true,
            accelerating: 0,
            turnTo: null,
        };
        applyJumpFlightMovement(
            movement, new Vector(1, 0), 30, 0.1, true);
        // MovementSystem already moved 1 unit at speed 10. The correction adds
        // 2 more, matching a single 0.1 s integration at jump speed 30.
        expect(movement.position.x).toBeCloseTo(3, 8);
        expect(movement.velocity).toEqual(new Vector(30, 0));
        expect(movement.rotation.angle)
            .toBeCloseTo(new Vector(1, 0).angle.angle, 8);
        expect(movement.turning).toBe(0);
        expect(movement.turnBack).toBeFalse();
        expect(movement.accelerating).toBe(1);
        expect(movement.turnTo).toEqual(new Vector(1, 0).angle);
    });

    it('cancels jump flight and stale remote presentation on death', () => {
        const movement: MovementState = {
            position: new Position(0, 0),
            velocity: new Vector(30, 0),
            rotation: new Angle(0),
            turning: 1,
            turnBack: true,
            accelerating: 1,
            turnTo: new Angle(0),
            targetSpeed: 140,
        };
        const entity = new Entity('player')
            .addComponent(JumpStateComponent, {
                from: 'a',
                to: 'b',
                phase: 'spooling',
                phaseStartedAt: 0,
                transitionAt: JUMP_SPOOL_MS,
                requiresAdjacency: true,
                arrivalSoundPending: false,
            })
            .addComponent(RemoteMovementPresentationComponent, {
                snapshots: [],
            });
        cancelJumpFlight(entity, movement);
        expect(entity.components.has(JumpStateComponent)).toBeFalse();
        expect(entity.components.has(
            RemoteMovementPresentationComponent)).toBeFalse();
        expect(movement.accelerating).toBe(0);
        expect(movement.turning).toBe(0);
        expect(movement.turnBack).toBeFalse();
        expect(movement.turnTo).toBeNull();
        expect(movement.targetSpeed).toBe(30);
    });
});

describe('hyperjump arrival geometry', () => {
    function expectDirection(
        source: [number, number],
        destination: [number, number],
        expectedPosition: [number, number],
        expectedVelocity: [number, number],
    ) {
        const arrival = calculateJumpArrival(
            source, destination, 100, 10);
        expect(arrival.position.x).toBeCloseTo(expectedPosition[0], 8);
        expect(arrival.position.y).toBeCloseTo(expectedPosition[1], 8);
        expect(arrival.velocity.x).toBeCloseTo(expectedVelocity[0], 8);
        expect(arrival.velocity.y).toBeCloseTo(expectedVelocity[1], 8);
        expect(arrival.rotation.angle)
            .toBeCloseTo(arrival.velocity.angle.angle, 8);
    }

    it('enters from the correct cardinal side', () => {
        expectDirection([0, 0], [10, 0], [-100, 0], [10, 0]);
        expectDirection([0, 0], [-10, 0], [100, 0], [-10, 0]);
        expectDirection([0, 0], [0, -10], [0, 100], [0, -10]);
        expectDirection([0, 0], [0, 10], [0, -100], [0, 10]);
    });

    it('generalizes to a diagonal galaxy-map vector', () => {
        const component = 100 / Math.sqrt(2);
        const speed = 10 / Math.sqrt(2);
        expectDirection(
            [5, 5],
            [15, 15],
            [-component, -component],
            [speed, speed],
        );
    });
});
