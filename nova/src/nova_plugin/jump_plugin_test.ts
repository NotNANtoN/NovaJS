import 'jasmine';
import {
    JUMP_ARRIVAL_END_SPEED_MULTIPLIER,
    JUMP_ARRIVAL_RADIUS,
    JUMP_ARRIVAL_SOUND_ID,
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
    takeArrivalSound,
    JUMP_MIN_DISTANCE,
    TOO_CLOSE_TO_CENTER_MESSAGE,
    NO_DESTINATION_MESSAGE,
    JumpRefusal,
    JumpRefusedEvent,
    JumpRouteComponent,
    applyJumpBrakingControls,
    advanceJumpFlight,
} from './jump_plugin';
import { ControlStateEvent } from './control_state_event';
import { PlayerStateComponent } from './player_state';
import { ShipDataComponent } from './ship_plugin';
import { SoundEvent } from './sound_event';
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

describe('arrival bang', () => {
    it('is a warp sound rather than an explosion', () => {
        // snd 302 "ShipBreaksUp" used to play here.
        expect(JUMP_ARRIVAL_SOUND_ID).toBe('nova:130');
    });

    it('sounds once and only when pending', () => {
        const state = { arrivalSoundPending: true };
        expect(takeArrivalSound(state)).toBe(JUMP_ARRIVAL_SOUND_ID);
        expect(state.arrivalSoundPending).toBeFalse();
        expect(takeArrivalSound(state)).toBeUndefined();
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

describe('player hyperjump checks and controls', () => {
    async function playerJumpWorld(options?: {
        x?: number;
        y?: number;
        route?: string[];
        fuel?: number;
    }) {
        const world = new World('player-jump-world');
        world.resources.set(PlatformResource, 'browser');
        const system = {
            name: 'Source System',
            position: [0, 0] as const,
            links: ['nova:dest'],
        };
        const destSystem = {
            name: 'Dest System',
            position: [100, 0] as const,
            links: ['nova:source'],
        };
        world.resources.set(GameDataResource, {
            data: {
                System: {
                    getCached: (id: string) => {
                        if (id === 'nova:source') return system;
                        if (id === 'nova:dest') return destSystem;
                        return undefined;
                    },
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

        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(JumpRouteComponent, { route: options?.route ?? ['nova:dest'] })
            .addComponent(MovementStateComponent, {
                position: new Position(options?.x ?? 1500, options?.y ?? 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            })
            .addComponent(MovementPhysicsComponent, NPC_PHYSICS)
            .addComponent(PlayerStateComponent, {
                fuel: options?.fuel ?? 300,
                currentSystem: 'nova:source',
                exploredSystems: ['nova:source'],
            } as never)
            .addComponent(ShipDataComponent, {
                fuelCapacity: 300,
            } as never);
        world.entities.set('player', player);

        return { world, player };
    }

    it('refuses jump when no destination is set', async () => {
        const { world, player } = await playerJumpWorld({ route: [] });
        let refused: JumpRefusal | undefined;
        let soundId: string | undefined;
        world.events.get(JumpRefusedEvent).subscribe(e => { refused = e; });
        world.events.get(SoundEvent).subscribe(s => { soundId = s.id; });

        world.emitNow(ControlStateEvent, new Map([['hyperjump', 'start']]), ['player']);

        expect(refused?.reason).toBe('destination');
        expect(soundId).toBe('nova:153');
        expect(player.components.has(JumpStateComponent)).toBeFalse();
    });

    it('refuses jump when within JUMP_MIN_DISTANCE from system center', async () => {
        const { world, player } = await playerJumpWorld({ x: 500, y: 0 });
        let refused: JumpRefusal | undefined;
        let soundId: string | undefined;
        world.events.get(JumpRefusedEvent).subscribe(e => { refused = e; });
        world.events.get(SoundEvent).subscribe(s => { soundId = s.id; });

        world.emitNow(ControlStateEvent, new Map([['hyperjump', 'start']]), ['player']);

        expect(refused?.reason).toBe('distance');
        expect(soundId).toBe('nova:153');
        expect(player.components.has(JumpStateComponent)).toBeFalse();
    });

    it('initiates braking jump when beyond JUMP_MIN_DISTANCE with destination', async () => {
        const { world, player } = await playerJumpWorld({ x: 1200, y: 0 });

        world.emitNow(ControlStateEvent, new Map([['hyperjump', 'start']]), ['player']);

        expect(player.components.has(JumpStateComponent)).toBeTrue();
        expect(player.components.get(JumpStateComponent)?.phase).toBe('braking');
    });

    it('cancels braking jump when tapping hyperjump again', async () => {
        const { world, player } = await playerJumpWorld({ x: 1200, y: 0 });

        world.emitNow(ControlStateEvent, new Map([['hyperjump', 'start']]), ['player']);
        expect(player.components.has(JumpStateComponent)).toBeTrue();

        world.emitNow(ControlStateEvent, new Map([['hyperjump', 'start']]), ['player']);
        expect(player.components.has(JumpStateComponent)).toBeFalse();
    });

    it('applyJumpBrakingControls steers towards destination heading once stopped', () => {
        const movement: MovementState = {
            position: new Position(1200, 0),
            velocity: new Vector(0, 0),
            rotation: new Angle(0),
            turning: 0,
            turnBack: false,
            accelerating: 0,
            turnTo: null,
        };
        const destVector = new Vector(1, 0); // East

        applyJumpBrakingControls(movement, 40, destVector);

        expect(movement.turnBack).toBeFalse();
        expect(movement.accelerating).toBe(0);
        expect(movement.turnTo).toEqual(destVector.angle);
    });

    it('advanceJumpFlight holds player in braking until aligned with jump heading', () => {
        const state = {
            from: 'nova:source',
            to: 'nova:dest',
            phase: 'braking' as const,
            phaseStartedAt: 0,
            transitionAt: JUMP_BRAKE_MS,
            requiresAdjacency: true,
            arrivalSoundPending: false,
        };
        const physics = { maxVelocity: 40 };
        const time = { time: 10, delta_s: 0.01 };
        const direction = new Vector(1, 0); // East (angle PI/2)

        // Case 1: Stopped but pointing North (angle 0) - dot product is 0 -> not aligned
        const misalignedMovement: MovementState = {
            position: new Position(1200, 0),
            velocity: new Vector(0, 0),
            rotation: new Angle(0), // North
            turning: 0,
            turnBack: false,
            accelerating: 0,
            turnTo: direction.angle,
        };

        const transition1 = advanceJumpFlight(state, misalignedMovement, physics, time, direction);
        expect(transition1).toBe('none');
        expect(state.phase).toBe('braking');

        // Case 2: Once aligned to East (rotation matches direction) -> transitions to spooling
        const alignedMovement: MovementState = {
            position: new Position(1200, 0),
            velocity: new Vector(0, 0),
            rotation: direction.angle, // East
            turning: 0,
            turnBack: false,
            accelerating: 0,
            turnTo: direction.angle,
        };

        let spoolingStarted = false;
        const transition2 = advanceJumpFlight(
            state,
            alignedMovement,
            physics,
            time,
            direction,
            undefined,
            () => { spoolingStarted = true; },
        );
        expect(transition2).toBe('none');
        expect(state.phase).toBe('spooling');
        expect(spoolingStarted).toBeTrue();
    });
});
