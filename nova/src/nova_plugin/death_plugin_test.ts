import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementPhysicsComponent,
    RemoteMovementPresentationComponent,
    MovementStateComponent,
    MovementSystem,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { ArmorComponent, ShieldComponent } from './health_plugin';
import {
    createInitialPlayerState,
    PlayerStateComponent,
} from './player_state';
import {
    AppliedDamageEvent,
    DamagedEvent,
    DeathEvent,
    DeathPlugin,
    DisabledComponent,
    PLAYER_DEATH_MESSAGE_HOLD_MS,
    PlayerDeathComponent,
    PlayerDeathState,
    RespawnRelocationEvent,
    ZeroArmorEvent,
    completePlayerDestruction,
    explosionVisualDurationMs,
} from './death_plugin';
import { System } from 'nova_ecs/system';
import { PlayerShipSelector } from './player_ship_plugin';
import { Position } from 'nova_ecs/datatypes/position';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Stat } from './stat';
import { BlastDamageComponent } from './blast_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { ShipDataComponent } from './ship_plugin';
import {
    JumpRouteComponent,
    JumpState,
    JumpStateComponent,
} from './jump_plugin';
import {
    multiplayer,
    MultiplayerData,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { MockCommunicator } from 'nova_ecs/plugins/mock_communicator';

describe('player death', () => {
    it('shows the message only after the final explosion lifetime', () => {
        const visualMs = explosionVisualDurationMs({
            id: 'nova:133',
            name: 'ship exploding',
            prefix: 'nova',
            sound: 'nova:303',
            rate: 1,
            animation: {
                id: 'nova:133',
                name: 'ship exploding',
                prefix: 'nova',
                images: {
                    baseImage: {
                        id: 'nova:4004',
                        dataType: 'SpriteSheetImage' as never,
                        blendMode: 1,
                        frames: { normal: { start: 0, length: 20 } },
                    },
                },
                exitPoints: {
                    gun: [], turret: [], guided: [], beam: [],
                    upCompress: [0, 0], downCompress: [0, 0],
                },
            },
        });
        expect(visualMs).toBeCloseTo(20 * 1000 / 30, 8);

        const death: PlayerDeathState = {
            wreckPosition: [0, 0] as [number, number],
            visualFallbackAt: 10_000,
        };
        completePlayerDestruction(death, visualMs);
        expect(death.messageAt).toBeCloseTo(visualMs, 8);
        expect(death.respawnAt).toBeCloseTo(
            visualMs + PLAYER_DEATH_MESSAGE_HOLD_MS, 8);
    });

    it('reports only shield and armor points actually removed', async () => {
        const world = new World('applied-damage-test');
        world.resources.set(TimeResource, {
            time: 0, delta_ms: 0, delta_s: 0, frame: 0,
        });
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);
        const applied: Array<{ shield: number, armor: number }> = [];
        world.addSystem(new System({
            name: 'RecordAppliedDamage',
            events: [AppliedDamageEvent],
            args: [AppliedDamageEvent] as const,
            step: damage => applied.push(damage),
        }));
        world.entities.set('target', new Entity('target')
            .addComponent(ShieldComponent, new Stat({
                current: 5, recharge: 0, max: 100,
            }))
            .addComponent(ArmorComponent, new Stat({
                current: 3, recharge: 0, max: 100,
            })));

        world.emitNow(DamagedEvent, {
            damage: {
                shield: 20,
                armor: 20,
                ionization: 0,
                ionizationColor: 0,
                passThroughShield: 0,
                knockback: 0,
            },
            damager: 'attacker',
        }, ['target']);

        expect(applied).toEqual([jasmine.objectContaining({
            shield: 5,
            armor: 3,
        })]);
    });

    it('marks destruction on the zero-armour event step', async () => {
        const world = new World('destruction-start-marker-test');
        world.resources.set(TimeResource, {
            time: 100, delta_ms: 0, delta_s: 0, frame: 0,
        });
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);
        const ship = new Entity('ship')
            .addComponent(ShipDataComponent, {
                ...getDefaultShipData(),
                deathDelay: 1,
            })
            .addComponent(ArmorComponent, new Stat({
                current: 1, recharge: 0, max: 1,
            }));
        world.entities.set('ship', ship);

        world.emitNow(DamagedEvent, {
            damage: {
                shield: 0,
                armor: 1,
                ionization: 0,
                ionizationColor: 0,
                passThroughShield: 1,
                knockback: 0,
            },
            damager: 'attacker',
        }, ['ship']);
        world.step();

        expect(ship.components.get(DestructionStartedComponent)).toBeTrue();
    });

    it('replicates destruction start and its respawn removal', async () => {
        const serverCommunicator = new MockCommunicator('server');
        const clientCommunicator = new MockCommunicator('client');
        const peers = new Map([
            ['server', serverCommunicator],
            ['client', clientCommunicator],
        ]);
        serverCommunicator.mockPeers = peers;
        clientCommunicator.mockPeers = peers;
        serverCommunicator.peers.current.next(new Set(peers.keys()));
        clientCommunicator.peers.current.next(new Set(peers.keys()));

        const time = {
            time: 100,
            delta_ms: 0,
            delta_s: 0,
            frame: 0,
        };
        const server = new World('destruction-server');
        server.resources.set(TimeResource, time);
        await server.addPlugin(multiplayer(serverCommunicator));
        await server.addPlugin(DeathPlugin);

        const client = new World('destruction-client');
        client.resources.set(TimeResource, { ...time });
        await client.addPlugin(multiplayer(clientCommunicator));
        await client.addPlugin(DeathPlugin);

        const playerState = createInitialPlayerState();
        const ship = new Entity('player')
            .addComponent(MultiplayerData, { owner: 'client' })
            .addComponent(ShipDataComponent, {
                ...getDefaultShipData(),
                deathDelay: 1,
            })
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, playerState)
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(10, 20),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(0, 0),
            });
        server.entities.set('player', ship);

        server.emitNow(ZeroArmorEvent, time, ['player']);
        expect(() => server.step()).not.toThrow();
        expect(() => client.step()).not.toThrow();
        expect(client.entities.get('player')?.components
            .get(DestructionStartedComponent)).toBeTrue();

        ship.components.set(DisabledComponent, true);
        ship.components.set(PlayerDeathComponent, {
            wreckPosition: [10, 20],
            visualFallbackAt: 0,
            messageAt: 0,
            respawnAt: time.time + 100,
        });
        expect(() => server.step()).not.toThrow();
        expect(() => client.step()).not.toThrow();
        expect(client.entities.get('player')?.components
            .get(DisabledComponent)).toBeTrue();
        expect(client.entities.get('player')?.components
            .has(PlayerDeathComponent)).toBeTrue();

        time.time += 100;
        expect(() => server.step()).not.toThrow();
        expect(() => client.step()).not.toThrow();
        expect(() => server.step()).not.toThrow();
        expect(() => client.step()).not.toThrow();

        expect(ship.components.has(DestructionStartedComponent)).toBeFalse();
        expect(client.entities.get('player')?.components
            .has(DestructionStartedComponent)).toBeFalse();
        expect(client.entities.get('player')?.components
            .has(PlayerDeathComponent)).toBeFalse();
    });

    it('holds the wreck, then respawns at the last landed position', async () => {
        const time = {
            time: 1_000,
            delta_ms: 0,
            delta_s: 0,
            frame: 0,
        };
        const state = createInitialPlayerState();
        state.lastLandedSystem = 'nova:130';
        state.lastLandedPosition = [321, -123];

        const world = new World('player-death-test');
        world.resources.set(TimeResource, time);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);

        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, state)
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(42, 24),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(4, 5),
            })
            .addComponent(ShieldComponent, new Stat({
                current: 0, recharge: 0, max: 100,
            }))
            .addComponent(ArmorComponent, new Stat({
                current: 0, recharge: 0, max: 200,
            }));
        world.entities.set('player', player);

        world.emitNow(DeathEvent, time, ['player']);
        world.step();

        const death = player.components.get(PlayerDeathComponent);
        expect(death?.wreckPosition).toEqual([42, 24]);
        expect(player.components.get(MovementStateComponent)!.velocity)
            .toEqual(new Vector(0, 0));

        time.time = 2_000;
        world.step();
        expect(player.components.get(MovementStateComponent)!.position)
            .toEqual(new Position(42, 24));

        time.time = death!.respawnAt!;
        world.step();

        expect(player.components.has(PlayerDeathComponent)).toBe(false);
        expect(player.components.get(MovementStateComponent)!.position)
            .toEqual(new Position(321, -123));
        expect(player.components.get(ShieldComponent)!.current).toBe(100);
        expect(player.components.get(ArmorComponent)!.current).toBe(200);
    });

    it('silently relocates cross-system respawns without jump state', async () => {
        const time = {
            time: 10_000,
            delta_ms: 0,
            delta_s: 0,
            frame: 0,
        };
        const state = createInitialPlayerState();
        state.currentSystem = 'nova:162';
        state.lastLandedSystem = 'nova:130';
        state.lastLandedPlanet = 'nova:128';
        state.lastLandedPosition = [12, 34];
        state.exploredSystems = ['nova:130', 'nova:162'];
        const route = { route: ['nova:531'] };
        const relocations: Array<{
            cause: 'respawn';
            from: string;
            to: string;
            entity: Entity;
        }> = [];
        const world = new World('cross-system-respawn-test');
        world.resources.set(TimeResource, time);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);
        world.addSystem(new System({
            name: 'RecordRespawnRelocation',
            events: [RespawnRelocationEvent],
            args: [RespawnRelocationEvent] as const,
            step: relocation => relocations.push(relocation),
        }));
        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, state)
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(100, 200),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(20, 30),
            })
            .addComponent(PlayerDeathComponent, {
                wreckPosition: [100, 200],
                visualFallbackAt: 0,
                messageAt: 1,
                respawnAt: time.time,
            })
            .addComponent(DestructionStartedComponent, true)
            .addComponent(JumpRouteComponent, route)
            .addComponent(JumpStateComponent, {
                from: 'nova:1',
                to: 'nova:2',
                phase: 'arriving',
                phaseStartedAt: 0,
                transitionAt: 1,
                requiresAdjacency: false,
                arrivalSoundPending: true,
            } as JumpState)
            .addComponent(
                RemoteMovementPresentationComponent,
                { snapshots: [] } as never,
            );
        world.entities.set('player', player);

        world.step();

        expect(world.entities.has('player')).toBeFalse();
        expect(relocations.length).toBe(1);
        expect(relocations[0]).toEqual(jasmine.objectContaining({
            cause: 'respawn',
            from: 'nova:162',
            to: 'nova:130',
            entity: player,
        }));
        expect(state.currentSystem).toBe('nova:130');
        expect(state.exploredSystems).toEqual(['nova:130', 'nova:162']);
        expect(route.route).toEqual(['nova:531']);
        expect(player.components.has(JumpStateComponent)).toBeFalse();
        expect(player.components.has(RemoteMovementPresentationComponent))
            .toBeFalse();
        expect(player.components.get(MovementStateComponent)?.position)
            .toEqual(new Position(12, 34));
        expect(player.components.get(MovementStateComponent)?.velocity)
            .toEqual(new Vector(0, 0));
    });

    it('keeps all ships moving after a coincident blast hit', async () => {
        const time = {
            time: 0,
            delta_ms: 100,
            delta_s: 0.1,
            frame: 0,
        };
        const world = new World('coincident-blast-movement-test');
        world.resources.set(TimeResource, time);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);
        world.addSystem(MovementSystem);
        const movementState = (x: number) => ({
            accelerating: 0,
            position: new Position(x, 0),
            rotation: new Angle(0),
            turnBack: false,
            turning: 0,
            velocity: new Vector(10, 0),
        });
        const movementPhysics = {
            acceleration: 0,
            maxVelocity: 20,
            turnRate: 0,
            movementType: MovementType.INERTIAL,
        };
        const damage = {
            shield: 0,
            armor: 0,
            ionization: 0,
            ionizationColor: 0,
            passThroughShield: 0,
            knockback: 10,
        };
        world.entities.set('blast', new Entity('blast')
            .addComponent(MovementStateComponent, movementState(0))
            .addComponent(BlastDamageComponent, damage));
        world.entities.set('victim', new Entity('victim')
            .addComponent(MovementStateComponent, movementState(0))
            .addComponent(MovementPhysicsComponent, movementPhysics));
        for (let index = 1; index <= 3; index++) {
            world.entities.set(`npc-${index}`, new Entity(`npc-${index}`)
                .addComponent(MovementStateComponent, movementState(index * 10))
                .addComponent(MovementPhysicsComponent, movementPhysics));
        }

        expect(() => world.emitNow(DamagedEvent, {
            damage,
            damager: 'blast',
            fromExplosion: true,
        }, ['victim'])).not.toThrow();
        world.step();

        for (let index = 1; index <= 3; index++) {
            expect(world.entities.get(`npc-${index}`)!.components
                .get(MovementStateComponent)!.position.x)
                .toBeGreaterThan(index * 10);
        }
    });
});
