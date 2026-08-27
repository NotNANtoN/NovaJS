import 'jasmine';
import {
    JUMP_ARRIVAL_END_SPEED_MULTIPLIER,
    JUMP_ARRIVAL_RADIUS,
    JUMP_ARRIVAL_MS,
    JUMP_ARRIVAL_SPEED_MULTIPLIER,
    JUMP_BAM_MS,
    JUMP_BRAKE_MS,
    JUMP_DEPARTURE_SPEED_MULTIPLIER,
    JUMP_SPOOL_MS,
    NPC_JUMP_TIMEOUT_MS,
    SYSTEM_DEPARTURE_RADIUS,
    InitiateJumpEvent,
    JumpPlugin,
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
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Entity } from 'nova_ecs/entity';
import {
    MovementPhysics,
    MovementPhysicsComponent,
    MovementState,
    MovementStateComponent,
    MovementPlugin,
    RemoteMovementPresentationComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { NpcAIComponent } from './npc_components';
import { PlayerShipSelector } from './player_ship_plugin';
import { SystemIdResource } from './system_id_resource';
import { GameDataResource } from './game_data_resource';
import { PlatformResource } from './platform_plugin';

const NPC_PHYSICS: MovementPhysics = {
    acceleration: 100,
    maxVelocity: 40,
    movementType: MovementType.INERTIAL,
    turnRate: 3,
};

function npcMovementAt(x: number, y: number): MovementState {
    return {
        position: new Position(x, y),
        velocity: new Vector(0, 0),
        rotation: new Angle(0),
        turning: 0,
        turnBack: false,
        accelerating: 0,
    };
}

function npcJumpEntity(
    x = 100,
    y = 0,
): Entity {
    return new Entity('npc')
        .addComponent(NpcAIComponent, undefined)
        .addComponent(MultiplayerData, { owner: 'server' })
        .addComponent(MovementStateComponent, npcMovementAt(x, y))
        .addComponent(MovementPhysicsComponent, NPC_PHYSICS);
}

async function npcJumpWorld() {
    const world = new World('npc-jump-test');
    world.resources.set(PlatformResource, 'node');
    world.resources.set(GameDataResource, {
        data: {
            System: {
                getCached: () => undefined,
            },
        },
    } as never);
    world.resources.set(SystemIdResource, 'nova:source');
    world.resources.set(TimeResource, {
        time: 0,
        delta_ms: 10,
        delta_s: 0.01,
        frame: 0,
    });
    await world.addPlugin(DeltaPlugin);
    await world.addPlugin(MovementPlugin);
    await world.addPlugin(JumpPlugin);
    return world;
}

describe('hyperjump lifecycle', () => {
    it('brakes, spools, performs the departure BAM, then arrives', () => {
        const braking = {
            phase: 'braking' as const,
            transitionAt: JUMP_BRAKE_MS,
        };
        expect(pendingJumpTransition(braking, JUMP_BRAKE_MS - 1))
            .toBe('none');
        expect(pendingJumpTransition(braking, JUMP_BRAKE_MS))
            .toBe('begin-spooling');

        const spooling = {
            phase: 'spooling' as const,
            transitionAt: JUMP_BRAKE_MS + JUMP_SPOOL_MS,
        };
        expect(pendingJumpTransition(spooling, spooling.transitionAt - 1))
            .toBe('none');
        expect(pendingJumpTransition(spooling, spooling.transitionAt))
            .toBe('begin-departure');

        const departing = {
            phase: 'departing' as const,
            transitionAt: spooling.transitionAt + JUMP_BAM_MS,
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
        expect(jumpFlightSpeed('braking', 0, maxVelocity)).toBe(0);
        expect(jumpFlightSpeed('spooling', 0, maxVelocity))
            .toBe(0);
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
            movement, new Vector(1, 0), 30, 0.1, true, true);
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

    it('turns into the spool heading before applying jump speed', () => {
        const movement = npcMovementAt(0, 0);

        applyJumpFlightMovement(
            movement, new Vector(1, 0), 30, 0.1, true, false);

        expect(movement.rotation).toEqual(new Angle(0));
        expect(movement.turnTo).toEqual(new Vector(1, 0).angle);
        expect(movement.velocity.length).toBe(0);
        expect(movement.targetSpeed).toBe(0);
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

describe('NPC hyperjump lifecycle', () => {
    it('brakes a moving ship before spooling', async () => {
        const world = await npcJumpWorld();
        const npc = npcJumpEntity();
        const movement = npc.components.get(MovementStateComponent)!;
        movement.velocity = new Vector(0, -20);
        world.entities.set('npc', npc);

        world.emitNow(InitiateJumpEvent, { to: 'nova:next' }, ['npc']);
        expect(npc.components.get(JumpStateComponent)?.phase)
            .toBe('braking');

        world.step();
        expect(npc.components.get(JumpStateComponent)?.phase)
            .toBe('braking');
        expect(movement.turnBack).toBeTrue();
        expect(movement.turnTo).toBeNull();

        const time = world.resources.get(TimeResource)!;
        for (let now = 10; now < JUMP_BRAKE_MS; now += 10) {
            time.time = now;
            world.step();
        }
        expect(movement.velocity.length).toBeLessThan(20);
        expect(npc.components.get(JumpStateComponent)?.phase)
            .toBe('braking');

        time.time = JUMP_BRAKE_MS;
        world.step();
        expect(npc.components.get(JumpStateComponent)?.phase)
            .toBe('spooling');
    });

    it('starts a stationary ship spooling promptly and gains speed',
        async () => {
        const world = await npcJumpWorld();
        const npc = npcJumpEntity();
        world.entities.set('npc', npc);

        world.emitNow(InitiateJumpEvent, { to: 'nova:next' }, ['npc']);
        expect(npc.components.get(JumpStateComponent)?.phase)
            .toBe('braking');

        world.step();
        expect(npc.components.get(JumpStateComponent)?.phase)
            .toBe('spooling');
        const spoolingSpeed = npc.components
            .get(MovementStateComponent)!.velocity.length;
        expect(spoolingSpeed).toBe(0);

        const time = world.resources.get(TimeResource)!;
        time.time = JUMP_SPOOL_MS;
        world.step();

        expect(npc.components.get(JumpStateComponent)?.phase)
            .toBe('departing');
        expect(npc.components.get(MovementStateComponent)!.velocity.length)
            .toBeGreaterThan(spoolingSpeed);
    });

    it('keeps departing NPCs until they exceed the system radius', async () => {
        const world = await npcJumpWorld();
        const npc = npcJumpEntity(SYSTEM_DEPARTURE_RADIUS - 1, 0);
        npc.components.set(JumpStateComponent, {
            from: 'nova:source',
            to: 'nova:next',
            phase: 'departing',
            phaseStartedAt: 0,
            transitionAt: JUMP_BAM_MS,
            requiresAdjacency: false,
            arrivalSoundPending: false,
            createdAt: 0,
        });
        world.entities.set('npc', npc);

        const time = world.resources.get(TimeResource)!;
        time.time = JUMP_SPOOL_MS + JUMP_BAM_MS + 1;
        time.delta_s = 0;
        world.step();
        expect(world.entities.has('npc')).toBeTrue();

        npc.components.get(MovementStateComponent)!.position =
            new Position(SYSTEM_DEPARTURE_RADIUS + 1, 0);
        world.step();
        expect(world.entities.has('npc')).toBeFalse();
    });

    it('removes a departing NPC after the timeout fallback', async () => {
        const world = await npcJumpWorld();
        const npc = npcJumpEntity();
        npc.components.set(JumpStateComponent, {
            from: 'nova:source',
            to: 'nova:next',
            phase: 'departing',
            phaseStartedAt: 0,
            transitionAt: JUMP_BAM_MS,
            requiresAdjacency: false,
            arrivalSoundPending: false,
            createdAt: 0,
        });
        world.entities.set('npc', npc);

        const time = world.resources.get(TimeResource)!;
        time.time = NPC_JUMP_TIMEOUT_MS;
        time.delta_s = 0;
        world.step();

        expect(world.entities.has('npc')).toBeFalse();
    });

    it('clears arrival state without applying the departure removal rule',
        async () => {
            const world = await npcJumpWorld();
            const npc = npcJumpEntity(0, -JUMP_ARRIVAL_RADIUS);
            npc.components.get(MovementStateComponent)!.rotation =
                new Angle(Math.PI);
            npc.components.set(JumpStateComponent, {
                from: '',
                to: '',
                phase: 'arriving',
                phaseStartedAt: 0,
                transitionAt: JUMP_ARRIVAL_MS,
                requiresAdjacency: false,
                arrivalSoundPending: false,
                createdAt: 0,
            });
            world.entities.set('npc', npc);

            const time = world.resources.get(TimeResource)!;
            world.step();
            expect(world.entities.has('npc')).toBeTrue();
            expect(npc.components.has(JumpStateComponent)).toBeTrue();

            time.time = JUMP_ARRIVAL_MS;
            time.delta_s = 0;
            world.step();

            expect(world.entities.has('npc')).toBeTrue();
            expect(npc.components.has(JumpStateComponent)).toBeFalse();
        });

    it('does not drive a player through the NPC lifecycle', async () => {
        const world = await npcJumpWorld();
        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(NpcAIComponent, undefined)
            .addComponent(MovementStateComponent, npcMovementAt(100, 0))
            .addComponent(MovementPhysicsComponent, NPC_PHYSICS)
            .addComponent(JumpStateComponent, {
                from: 'nova:source',
                to: 'nova:next',
                phase: 'departing',
                phaseStartedAt: 0,
                transitionAt: JUMP_BAM_MS,
                requiresAdjacency: false,
                arrivalSoundPending: false,
                createdAt: 0,
            });
        world.entities.set('player', player);

        const time = world.resources.get(TimeResource)!;
        time.time = JUMP_BAM_MS + 1;
        world.step();

        expect(player.components.get(JumpStateComponent)?.phase)
            .toBe('departing');
        expect(player.components.get(MovementStateComponent)!.velocity.length)
            .toBe(0);
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
