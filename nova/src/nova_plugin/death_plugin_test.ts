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
import {
    ArmorComponent,
    HealthPlugin,
    ShieldComponent,
} from './health_plugin';
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
    recordPlayerDeath,
    shouldShowDeathOverlay,
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
import {
    ShipComponent,
    ShipDataComponent,
} from './ship_plugin';
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
import { OutfitsStateComponent } from './outfit_plugin';
import { GameDataResource } from './game_data_resource';
import { PlatformResource } from './platform_plugin';

async function makeNetworkedCombatWorlds() {
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

    const serverTime = {
        time: 0, delta_ms: 0, delta_s: 0, frame: 0,
    };
    const clientTime = { ...serverTime };
    const server = new World('combat-server');
    server.resources.set(TimeResource, serverTime);
    server.resources.set(PlatformResource, 'node');
    await server.addPlugin(multiplayer(serverCommunicator));
    await server.addPlugin(HealthPlugin);
    await server.addPlugin(DeathPlugin);

    const client = new World('combat-client');
    client.resources.set(TimeResource, clientTime);
    client.resources.set(PlatformResource, 'browser');
    await client.addPlugin(multiplayer(clientCommunicator));
    await client.addPlugin(HealthPlugin);
    await client.addPlugin(DeathPlugin);

    return { client, server };
}

describe('player death', () => {
    it('marks only killed pilots as dead', () => {
        const killed = createInitialPlayerState();
        const escaped = createInitialPlayerState();

        recordPlayerDeath(killed, 'killed', 12_345);
        recordPlayerDeath(escaped, 'escaped', 12_345);

        expect(killed.diedAt).toBe(12_345);
        expect(escaped.diedAt).toBeUndefined();
    });

    it('shows the message overlay only for an escaped pilot', () => {
        const death = {
            wreckPosition: [0, 0] as [number, number],
            visualFallbackAt: 100,
            messageAt: 50,
            message: 'Escape pod rescue',
        };

        expect(shouldShowDeathOverlay({
            ...death,
            outcome: 'escaped',
        }, 50)).toBeTrue();
        expect(shouldShowDeathOverlay({
            ...death,
            outcome: 'killed',
        }, 50)).toBeFalse();
        expect(shouldShowDeathOverlay({
            ...death,
            outcome: 'escaped',
        }, 49)).toBeFalse();
    });

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

    it('rejects a client-authored health delta', async () => {
        const { client, server } = await makeNetworkedCombatWorlds();
        const serverShield = new Stat({
            current: 100, recharge: 0, max: 100,
        });
        server.entities.set('ship', new Entity('ship')
            .addComponent(MultiplayerData, { owner: 'client' })
            .addComponent(ShieldComponent, serverShield));

        for (let frame = 0; frame < 3; frame++) {
            server.step();
            client.step();
        }
        const clientShield = client.entities.get('ship')?.components
            .get(ShieldComponent);
        expect(clientShield?.current).toBe(100);

        clientShield!.current = 1;
        clientShield!.lastSent = 0;
        client.step();
        server.step();

        expect(server.entities.get('ship')?.components
            .get(ShieldComponent)?.current).toBe(100);
    });

    it('replicates server-applied damage without client prediction',
        async () => {
            const { client, server } = await makeNetworkedCombatWorlds();
            const serverShield = new Stat({
                current: 100, recharge: 0, max: 100,
            });
            server.entities.set('ship', new Entity('ship')
                .addComponent(MultiplayerData, { owner: 'client' })
                .addComponent(ShieldComponent, serverShield));
            for (let frame = 0; frame < 3; frame++) {
                server.step();
                client.step();
            }
            const damage = {
                shield: 25,
                armor: 0,
                ionization: 0,
                ionizationColor: 0,
                passThroughShield: 0,
                knockback: 0,
            };
            const clientShield = client.entities.get('ship')!.components
                .get(ShieldComponent)!;

            client.emitNow(DamagedEvent, {
                damage,
                damager: 'projectile',
            }, ['ship']);
            expect(clientShield.current).toBe(100);

            server.emitNow(DamagedEvent, {
                damage,
                damager: 'projectile',
            }, ['ship']);
            const currentServerShield = server.entities.get('ship')!.components
                .get(ShieldComponent)!;
            expect(currentServerShield.current).toBe(75);
            currentServerShield.lastSent = 0;
            server.step();
            client.step();

            expect(client.entities.get('ship')?.components
                .get(ShieldComponent)?.current).toBe(75);
        });

    it('recharges health only on the server and replicates the result',
        async () => {
            const { client, server } = await makeNetworkedCombatWorlds();
            server.entities.set('ship', new Entity('ship')
                .addComponent(MultiplayerData, { owner: 'client' })
                .addComponent(ShieldComponent, new Stat({
                    current: 50, recharge: 10, max: 100,
                })));
            for (let frame = 0; frame < 3; frame++) {
                server.step();
                client.step();
            }

            client.resources.get(TimeResource)!.delta_s = 1;
            client.step();
            expect(client.entities.get('ship')?.components
                .get(ShieldComponent)?.current).toBe(50);

            server.resources.get(TimeResource)!.delta_s = 1;
            const serverShield = server.entities.get('ship')!.components
                .get(ShieldComponent)!;
            serverShield.lastSent = 0;
            server.step();
            server.resources.get(TimeResource)!.delta_s = 0;
            server.entities.get('ship')!.components
                .get(ShieldComponent)!.lastSent = 0;
            server.step();
            client.step();

            expect(server.entities.get('ship')?.components
                .get(ShieldComponent)?.current).toBe(60);
            expect(client.entities.get('ship')?.components
                .get(ShieldComponent)?.current).toBe(60);
        });

    it('resolves a fatal hit in exactly one world', async () => {
        const { client, server } = await makeNetworkedCombatWorlds();
        const makeTarget = () => new Entity('ship')
            .addComponent(MultiplayerData, { owner: 'client' })
            .addComponent(ShipDataComponent, {
                ...getDefaultShipData(),
                deathDelay: 0,
            })
            .addComponent(ArmorComponent, new Stat({
                current: 10, recharge: 0, max: 10,
            }));
        server.entities.set('ship', makeTarget());
        client.entities.set('ship', makeTarget());
        let serverDeaths = 0;
        let clientDeaths = 0;
        server.events.get(DeathEvent).subscribe(() => serverDeaths++);
        client.events.get(DeathEvent).subscribe(() => clientDeaths++);
        const fatalDamage = {
            shield: 0,
            armor: 10,
            ionization: 0,
            ionizationColor: 0,
            passThroughShield: 1,
            knockback: 0,
        };

        client.emitNow(DamagedEvent, {
            damage: fatalDamage,
            damager: 'projectile',
        }, ['ship']);
        server.emitNow(DamagedEvent, {
            damage: fatalDamage,
            damager: 'projectile',
        }, ['ship']);
        server.step();
        client.step();
        server.resources.get(TimeResource)!.time = 1;
        client.resources.get(TimeResource)!.time = 1;
        server.step();
        client.step();
        server.step();
        client.step();

        expect(serverDeaths).toBe(1);
        expect(clientDeaths).toBe(0);
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
        server.resources.set(PlatformResource, 'node');
        await server.addPlugin(multiplayer(serverCommunicator));
        await server.addPlugin(DeathPlugin);

        const client = new World('destruction-client');
        client.resources.set(TimeResource, { ...time });
        client.resources.set(PlatformResource, 'browser');
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
        expect(ship.components.has(DisabledComponent)).toBeFalse();
        expect(client.entities.get('player')?.components
            .has(DisabledComponent)).toBeFalse();
    });

    it('marks a killed pilot without showing or scheduling a respawn',
        async () => {
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
            .addComponent(OutfitsStateComponent, new Map())
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

        time.time = death!.messageAt! + PLAYER_DEATH_MESSAGE_HOLD_MS;
        world.step();

        expect(death?.outcome).toBe('killed');
        expect(death?.message).toBeUndefined();
        expect(death?.respawnAt).toBeUndefined();
        expect(state.diedAt).toEqual(jasmine.any(Number));
        expect(player.components.has(PlayerDeathComponent)).toBe(true);
        expect(player.components.get(MovementStateComponent)!.position)
            .toEqual(new Position(42, 24));
        expect(player.components.get(ShieldComponent)!.current).toBe(0);
        expect(player.components.get(ArmorComponent)!.current).toBe(0);
    });

    it('kills a pilot in a world that has no browser ship marker', async () => {
        // The authoritative world is the only one that resolves death, and it
        // never has PlayerShipSelector: that marker means "the ship I am
        // flying" and is set by the browser. A pilot whose death depended on it
        // simply sat at zero armor being shot forever.
        const time = {
            time: 1_000,
            delta_ms: 0,
            delta_s: 0,
            frame: 0,
        };
        const world = new World('server-side-player-death-test');
        world.resources.set(TimeResource, time);
        world.resources.set(PlatformResource, 'node');
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);

        const player = new Entity('player')
            .addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(OutfitsStateComponent, new Map())
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(7, 8),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(3, 3),
            })
            .addComponent(ArmorComponent, new Stat({
                current: 0, recharge: 0, max: 200,
            }));
        world.entities.set('player', player);

        world.emitNow(DeathEvent, time, ['player']);
        world.step();

        expect(player.components.get(PlayerDeathComponent)?.wreckPosition)
            .toEqual([7, 8]);
    });

    it('consumes the pod and recovers the pilot in a basic hull', async () => {
        const time = {
            time: 1_000,
            delta_ms: 0,
            delta_s: 0,
            frame: 0,
        };
        const state = createInitialPlayerState();
        state.shipId = 'nova:200';
        state.lastLandedPosition = [321, -123];
        state.holds = [{
            commodity: 'Food',
            tons: 5,
            isMissionCargo: false,
        }];
        state.kills = 7;
        const basicHull = {
            ...getDefaultShipData(),
            id: 'nova:128',
            name: 'Shuttle',
            cargoCapacity: 10,
            fuelCapacity: 300,
            physics: {
                ...getDefaultShipData().physics,
                shield: 30,
                armor: 30,
                ionization: 10,
            },
            outfits: {
                'nova:128': 1,
            },
        };
        const outfitData = {
            pod: {
                isEscapePod: true,
                physics: { freeMass: 1 },
            },
            'nova:128': {
                isEscapePod: false,
                physics: { freeMass: 1 },
            },
        } as const;

        const world = new World('escape-pod-death-test');
        world.resources.set(TimeResource, time);
        world.resources.set(GameDataResource, {
            data: {
                Explosion: { getCached: () => undefined },
                Outfit: {
                    getCached: (id: keyof typeof outfitData) =>
                        outfitData[id],
                },
                Ship: {
                    get: async () => basicHull,
                    getCached: () => basicHull,
                },
            },
        } as never);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);

        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, state)
            .addComponent(ShipComponent, { id: 'nova:200' })
            .addComponent(ShipDataComponent, {
                ...getDefaultShipData(),
                id: 'nova:200',
            })
            .addComponent(OutfitsStateComponent, new Map([
                ['pod', { count: 1 }],
                ['old-weapon', { count: 2 }],
            ]))
            .addComponent(MovementStateComponent, {
                accelerating: 1,
                position: new Position(42, 24),
                rotation: new Angle(0),
                turnBack: false,
                turning: 1,
                turnTo: new Angle(1),
                velocity: new Vector(4, 5),
            })
            .addComponent(ShieldComponent, new Stat({
                current: 0, recharge: 0, max: 100,
            }))
            .addComponent(ArmorComponent, new Stat({
                current: 0, recharge: 0, max: 200,
            }))
            .addComponent(DisabledComponent, true)
            .addComponent(DestructionStartedComponent, true);
        world.entities.set('player', player);

        world.emitNow(DeathEvent, time, ['player']);
        world.step();
        const death = player.components.get(PlayerDeathComponent);
        expect(death?.outcome).toBe('escaped');
        expect(death?.escapePodOutfitId).toBe('pod');
        expect(death?.message).toContain('a passing prospector');
        expect(state.diedAt).toBeUndefined();

        time.time = death!.respawnAt!;
        world.step();

        expect(player.components.has(PlayerDeathComponent)).toBeFalse();
        expect(player.components.has(DisabledComponent)).toBeFalse();
        expect(player.components.has(DestructionStartedComponent)).toBeFalse();
        expect(player.components.get(ShipComponent)?.id).toBe('nova:128');
        expect(player.components.get(OutfitsStateComponent)).toEqual(new Map([
            ['nova:128', { count: 1 }],
        ]));
        expect(state.shipId).toBe('nova:128');
        expect(state.holds).toEqual([]);
        expect(state.kills).toBe(7);
        expect(player.components.get(MovementStateComponent)?.position)
            .toEqual(new Position(321, -123));
        expect(player.components.get(MovementStateComponent)?.accelerating)
            .toBe(0);
        expect(player.components.get(MovementStateComponent)?.turning).toBe(0);
        expect(player.components.get(ShieldComponent)?.current).toBe(30);
        expect(player.components.get(ArmorComponent)?.current).toBe(30);
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

    it('does not knock a client-owned ship on the server', async () => {
        const world = new World('server-knockback-authority');
        world.resources.set(TimeResource, {
            time: 0, delta_ms: 16, delta_s: 0.016, frame: 0,
        });
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);
        world.resources.set(PlatformResource, 'node');
        world.entities.set('shooter', new Entity('shooter')
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(0, 0),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(10, 0),
            }));
        world.entities.set('victim', new Entity('victim')
            .addComponent(MultiplayerData, { owner: 'player' })
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(0, 0),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(10, 0),
            })
            .addComponent(MovementPhysicsComponent, {
                acceleration: 0,
                maxVelocity: 200,
                turnRate: 0,
                movementType: MovementType.INERTIAL,
            }));
        world.emitNow(DamagedEvent, {
            damage: {
                shield: 0,
                armor: 0,
                ionization: 0,
                ionizationColor: 0,
                passThroughShield: 0,
                knockback: 10,
            },
            damager: 'shooter',
        }, ['victim']);
        expect(world.entities.get('victim')!.components
            .get(MovementStateComponent)!.velocity.x).toBe(10);
    });

    it('does not knock a remotely presented ship', async () => {
        const world = new World('remote-knockback-authority');
        world.resources.set(TimeResource, {
            time: 0, delta_ms: 16, delta_s: 0.016, frame: 0,
        });
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);
        world.entities.set('shooter', new Entity('shooter')
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(0, 0),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(10, 0),
            }));
        world.entities.set('victim', new Entity('victim')
            .addComponent(RemoteMovementPresentationComponent, { snapshots: [] })
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(0, 0),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(10, 0),
            })
            .addComponent(MovementPhysicsComponent, {
                acceleration: 0,
                maxVelocity: 200,
                turnRate: 0,
                movementType: MovementType.INERTIAL,
            }));
        world.emitNow(DamagedEvent, {
            damage: {
                shield: 0,
                armor: 0,
                ionization: 0,
                ionizationColor: 0,
                passThroughShield: 0,
                knockback: 10,
            },
            damager: 'shooter',
        }, ['victim']);
        expect(world.entities.get('victim')!.components
            .get(MovementStateComponent)!.velocity.x).toBe(10);
    });
});
