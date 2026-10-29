import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { Entity } from 'nova_ecs/entity';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import {
    MovementPhysicsComponent,
    MovementPlugin,
    MovementStateComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { ArmorComponent, ShieldComponent } from './health_plugin';
import { DudeSourceComponent } from './boarding_plugin';
import { GameDataResource } from './game_data_resource';
import { GovtComponent } from './npc_plugin';
import { NpcSpawnPlugin } from './npc_spawn_plugin';
import { NpcAIComponent } from './npc_hostility';
import { NpcCombatRoleComponent } from './npc_components';
import { PlanetComponent } from './planet_plugin';
import { EntityBudgetResource, createEntityBudget } from './entity_budget';
import { SystemIdResource } from './system_id_resource';
import {
    JUMP_ARRIVAL_MS,
    JumpPlugin,
    JumpStateComponent,
    SYSTEM_DEPARTURE_RADIUS,
} from './jump_plugin';
import { ShipComponent } from './ship_plugin';
import {
    advanceCachedSystemState,
    captureSystemNpcState,
    getCachedSystemState,
    resetSystemStateTracker,
} from './system_state_tracker';
import { DeathEvent, DeathPlugin } from './death_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { PlatformResource } from './platform_plugin';
import { Stat } from './stat';
import { combatRoleForDudeAiType } from 'novaparse/src/parsers/SystemParse';

/**
 * Let the spawner's pending work finish.
 *
 * Counting individual microtasks here would tie the test to how deeply the
 * spawn path happens to nest its awaits, so any honest refactor of that path
 * would fail the test without any change in behavior.
 */
async function settle(): Promise<void> {
    for (let drain = 0; drain < 16; drain++) {
        await Promise.resolve();
    }
}

describe('NPC spawning', () => {
    it('derives defense eligibility from retail düde AI roles', () => {
        expect(combatRoleForDudeAiType(1)).toBe('civilian');
        expect(combatRoleForDudeAiType(2)).toBe('civilian');
        expect(combatRoleForDudeAiType(3)).toBe('military');
        expect(combatRoleForDudeAiType(4)).toBe('military');
        expect(combatRoleForDudeAiType(0)).toBe('personal');
    });

    it('marks düde-backed spawns so their booty can be looked up', async () => {
        const spawnWorld = async (kind: 'dude' | 'fleet' | undefined) => {
            const gameData = {
                data: {
                    System: {
                        get: async () => ({
                            avgShips: 1,
                            npcs: [{
                                id: 'nova:129',
                                weight: 1,
                                government: 1,
                                kind,
                                ships: [{ id: 'nova:128', weight: 1 }],
                            }],
                        }),
                    },
                    Ship: { get: async () => getDefaultShipData() },
                },
            };
            const world = new World('npc-provenance-test');
            world.resources.set(GameDataResource, gameData as never);
            world.resources.set(SystemIdResource, 'nova:test');
            world.resources.set(TimeResource, {
                time: 0, delta_ms: 1000 / 60, delta_s: 1 / 60, frame: 0,
            });
            world.resources.set(
                EntityBudgetResource, createEntityBudget('modern'));
            await world.addPlugin(DeltaPlugin);
            await world.addPlugin(DeathPlugin);
            await world.addPlugin(NpcSpawnPlugin);
            world.step();
            await settle();
            world.step();
            await settle();
            return [...world.entities.values()]
                .filter(entity => entity.components.has(NpcAIComponent));
        };

        const dudeShips = await spawnWorld('dude');
        expect(dudeShips.length).toBeGreaterThan(0);
        expect(dudeShips[0].components.get(DudeSourceComponent))
            .toEqual({ id: 'nova:129' });

        // A flët names a coordinated group, not a booty class, and older
        // generated data says nothing at all.
        for (const kind of ['fleet', undefined] as const) {
            const ships = await spawnWorld(kind);
            expect(ships.length).toBeGreaterThan(0);
            expect(ships[0].components.has(DudeSourceComponent)).toBeFalse();
        }
    });

    it('keeps the target population through player respawn', async () => {
        const gameData = {
            data: {
                System: {
                    get: async () => ({
                        avgShips: 3,
                        npcs: [{
                            id: 'test-npc',
                            weight: 1,
                            government: 1,
                            combatRole: 'civilian',
                            ships: [{ id: 'nova:128', weight: 1 }],
                        }],
                    }),
                },
                Ship: {
                    get: async () => getDefaultShipData(),
                },
            },
        };
        const world = new World('npc-spawn-test');
        const time = {
            time: 0,
            delta_ms: 1000 / 60,
            delta_s: 1 / 60,
            frame: 0,
        };
        world.resources.set(GameDataResource, gameData as never);
        world.resources.set(SystemIdResource, 'nova:test');
        world.resources.set(TimeResource, time);
        world.resources.set(EntityBudgetResource, createEntityBudget('modern'));
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);
        await world.addPlugin(NpcSpawnPlugin);

        for (let i = 0; i < 2; i++) {
            world.entities.set(`existing-${i}`, new Entity()
                .addComponent(NpcAIComponent, undefined)
                .addComponent(GovtComponent, { id: 1 })
                .addComponent(MultiplayerData, { owner: 'server' }));
        }

        world.step();
        await settle();
        world.step();
        await settle();

        const npcCount = [...world.entities.values()].filter(entity =>
            entity.components.has(NpcAIComponent)).length;
        expect(npcCount).toBe(3);
        expect([...world.entities.values()].filter(entity =>
            entity.components.has(NpcAIComponent)
            && entity.components.get(NpcCombatRoleComponent) === 'civilian')
            .length).toBe(1);

        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(0, 0),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(0, 0),
            })
            .addComponent(ShieldComponent, new Stat({
                current: 0, recharge: 0, max: 1,
            }))
            .addComponent(ArmorComponent, new Stat({
                current: 0, recharge: 0, max: 1,
            }));
        world.entities.set('player', player);
        world.emitNow(DeathEvent, time, ['player']);
        world.step();
        time.time = 2_500;
        world.step();
        await settle();
        world.step();

        expect([...world.entities.values()].filter(entity =>
            entity.components.has(NpcAIComponent)).length).toBe(3);
    });

    it('uses live planets when the initial data cache is cold', async () => {
        spyOn(Math, 'random').and.returnValue(0.1);

        const planetPosition = [300, -200] as const;
        const gameData = {
            data: {
                System: {
                    get: async () => ({
                        position: [0, 0],
                        links: [],
                        planets: ['nova:128'],
                        avgShips: 4,
                        npcs: [{
                            id: 'test-npc',
                            weight: 1,
                            government: 1,
                            combatRole: 'civilian',
                            ships: [{ id: 'nova:128', weight: 1 }],
                        }],
                    }),
                },
                Planet: {
                    get: async () => ({
                        id: 'nova:128',
                        position: [...planetPosition],
                        inhabited: true,
                    }),
                    getCached: () => undefined,
                },
                Ship: {
                    get: async () => getDefaultShipData(),
                },
            },
        };
        const world = new World('npc-cold-planet-cache-test');
        world.resources.set(GameDataResource, gameData as never);
        world.resources.set(SystemIdResource, 'nova:test');
        world.resources.set(TimeResource, {
            time: 0, delta_ms: 1000 / 60, delta_s: 1 / 60, frame: 0,
        });
        world.resources.set(
            EntityBudgetResource, createEntityBudget('modern'));
        world.entities.set('planet nova:128', new Entity('Earth')
            .addComponent(PlanetComponent, {
                id: 'nova:128',
                inhabited: true,
            })
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(...planetPosition),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(0, 0),
            }));
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);
        await world.addPlugin(NpcSpawnPlugin);

        world.step();
        await settle();
        world.step();
        await settle();

        const npcShips = [...world.entities.values()].filter(entity =>
            entity.components.has(NpcAIComponent));
        const localLaunches = npcShips.filter(entity => {
            const movement = entity.components.get(MovementStateComponent);
            if (!movement) {
                return false;
            }
            return Math.abs(Math.hypot(
                movement.position.x - planetPosition[0],
                movement.position.y - planetPosition[1],
            ) - 700) < 1e-6;
        });

        expect(localLaunches.length).toBeGreaterThan(0);
    });

    it('animates hyperspace arrivals before returning them to normal flight',
        async () => {
            const gameData = {
                data: {
                    System: {
                        get: async () => ({
                            position: [0, 0],
                            links: [],
                            planets: [],
                            avgShips: 1,
                            npcs: [{
                                id: 'test-npc',
                                weight: 1,
                                government: 1,
                                combatRole: 'civilian',
                                ships: [{ id: 'nova:128', weight: 1 }],
                            }],
                        }),
                    },
                    Ship: {
                        get: async () => getDefaultShipData(),
                    },
                },
            };
            const time = {
                time: 0,
                delta_ms: 1_000 / 60,
                delta_s: 1 / 60,
                frame: 0,
            };
            const world = new World('npc-arrival-jump-test');
            world.resources.set(GameDataResource, gameData as never);
            world.resources.set(SystemIdResource, 'nova:test');
            world.resources.set(PlatformResource, 'node');
            world.resources.set(TimeResource, time);
            world.resources.set(
                EntityBudgetResource, createEntityBudget('modern'));
            await world.addPlugin(DeltaPlugin);
            await world.addPlugin(MovementPlugin);
            await world.addPlugin(JumpPlugin);
            await world.addPlugin(NpcSpawnPlugin);

            world.step();
            await settle();
            world.step();
            await settle();

            const npc = [...world.entities.values()].find(entity =>
                entity.components.has(NpcAIComponent));
            expect(npc).toBeDefined();
            expect(npc?.components.get(JumpStateComponent)?.phase)
                .toBe('arriving');

            if (!npc) {
                return;
            }
            npc.components.set(MovementPhysicsComponent, {
                acceleration: 1,
                maxVelocity: 40,
                movementType: MovementType.INERTIAL,
                turnRate: 1,
            });
            time.time = JUMP_ARRIVAL_MS;
            time.delta_s = 0;
            world.step();

            expect(world.entities.has(npc.uuid)).toBeTrue();
            expect(npc.components.has(JumpStateComponent)).toBeFalse();
        });

    it('persists system state on room exit so destroyed ships cease to exist and survivors dead-reckon',
        async () => {
            const gameData = {
                data: {
                    System: {
                        get: async () => ({
                            id: 'nova:130',
                            position: [0, 0],
                            links: ['nova:129'],
                            planets: [],
                            avgShips: 4,
                            npcs: [{
                                id: 'test-npc',
                                weight: 1,
                                government: 128,
                                combatRole: 'civilian',
                                ships: [{ id: 'nova:128', weight: 1 }],
                            }],
                        }),
                        getCached: (id: string) => id === 'nova:130'
                            ? { id: 'nova:130', position: [0, 0], links: ['nova:129'], planets: [] }
                            : { id: 'nova:129', position: [100, 0], links: ['nova:130'], planets: [] },
                    },
                    Ship: {
                        get: async () => getDefaultShipData(),
                    },
                },
            };
            resetSystemStateTracker(gameData);

            const time = {
                time: 0,
                delta_ms: 1_000 / 60,
                delta_s: 1 / 60,
                frame: 0,
            };
            const world1 = new World('system-130-visit-1');
            world1.resources.set(GameDataResource, gameData as never);
            world1.resources.set(SystemIdResource, 'nova:130');
            world1.resources.set(PlatformResource, 'node');
            world1.resources.set(TimeResource, time);
            world1.resources.set(EntityBudgetResource, createEntityBudget('modern'));
            await world1.addPlugin(DeltaPlugin);
            await world1.addPlugin(DeathPlugin);
            await world1.addPlugin(NpcSpawnPlugin);

            world1.step();
            await settle();
            world1.step();
            await settle();

            const initialNpcs = [...world1.entities.entries()]
                .filter(([, entity]) => entity.components.has(NpcAIComponent));
            expect(initialNpcs.length).toBe(4);

            // Destroy 2 of the 4 ships so they cease to exist
            world1.entities.delete(initialNpcs[0][0]);
            world1.entities.delete(initialNpcs[1][0]);

            // Set specific known positions and velocities on the 2 survivors
            const survivorUuid = initialNpcs[2][0];
            const survivorEntity = initialNpcs[2][1];
            survivorEntity.name = 'Tracked Freighter';
            const survivorMov = survivorEntity.components.get(MovementStateComponent)!;
            survivorMov.position = new Position(100, -200);
            survivorMov.velocity = new Vector(0, -100);
            survivorMov.rotation = new Angle(0);
            survivorEntity.components.delete(JumpStateComponent);

            const survivor2Uuid = initialNpcs[3][0];
            const survivor2Entity = initialNpcs[3][1];
            const survivor2Mov = survivor2Entity.components.get(MovementStateComponent)!;
            survivor2Mov.position = new Position(-300, 100);
            survivor2Mov.velocity = new Vector(-80, 0);
            survivor2Mov.rotation = new Angle(-Math.PI / 2);
            survivor2Entity.components.delete(JumpStateComponent);

            // Close the room (NpcSpawnPlugin.remove automatically captures system state)
            await world1.removePlugin(NpcSpawnPlugin);
            const cached = getCachedSystemState(gameData, 'nova:130');
            expect(cached?.ships.length).toBe(2);

            // Re-enter system 2 seconds later (12_000 < 9_000 natural replacement cadence):
            // the 2 destroyed ships must still be gone and the 2 survivors must be restored!
            const world2 = new World('system-130-visit-2');
            world2.resources.set(GameDataResource, gameData as never);
            world2.resources.set(SystemIdResource, 'nova:130');
            world2.resources.set(PlatformResource, 'node');
            world2.resources.set(TimeResource, time);
            world2.resources.set(EntityBudgetResource, createEntityBudget('modern'));
            await world2.addPlugin(DeltaPlugin);
            await world2.addPlugin(DeathPlugin);
            await world2.addPlugin(NpcSpawnPlugin);

            world2.step();
            await settle();
            world2.step();
            await settle();

            const restoredNpcs = [...world2.entities.entries()]
                .filter(([, entity]) => entity.components.has(NpcAIComponent));
            expect(restoredNpcs.length).toBe(2);
            const restoredSurvivor = world2.entities.get(survivorUuid);
            expect(restoredSurvivor).toBeDefined();
            expect(restoredSurvivor?.name).toBe('Tracked Freighter');
            expect(world2.entities.has(survivor2Uuid)).toBeTrue();
        });

    it('lets the player follow a jumping or outbound NPC ship into the destination system',
        async () => {
            const systems = new Map([
                ['nova:130', {
                    id: 'nova:130',
                    position: [0, 0] as const,
                    links: ['nova:129'],
                    planets: [],
                    avgShips: 1,
                    npcs: [{
                        id: 'test-npc',
                        weight: 1,
                        government: 128,
                        combatRole: 'military',
                        ships: [{ id: 'nova:128', weight: 1 }],
                    }],
                }],
                ['nova:129', {
                    id: 'nova:129',
                    position: [100, 0] as const,
                    links: ['nova:130'],
                    planets: [],
                    avgShips: 1,
                    npcs: [],
                }],
            ]);
            const gameData = {
                data: {
                    System: {
                        get: async (id: string) => systems.get(id),
                        getCached: (id: string) => systems.get(id),
                    },
                    Ship: {
                        get: async () => ({
                            ...getDefaultShipData(),
                            id: 'nova:141',
                            name: 'Fed Destroyer',
                        }),
                    },
                },
            };
            resetSystemStateTracker(gameData);

            const time = {
                time: 1_000,
                delta_ms: 1_000 / 60,
                delta_s: 1 / 60,
                frame: 0,
            };
            const sourceWorld = new World('source-system-130');
            sourceWorld.resources.set(GameDataResource, gameData as never);
            sourceWorld.resources.set(SystemIdResource, 'nova:130');
            sourceWorld.resources.set(PlatformResource, 'node');
            sourceWorld.resources.set(TimeResource, time);
            sourceWorld.resources.set(EntityBudgetResource, createEntityBudget('modern'));
            await sourceWorld.addPlugin(DeltaPlugin);
            await sourceWorld.addPlugin(MovementPlugin);
            await sourceWorld.addPlugin(JumpPlugin);

            const flagship = new Entity('Valiant (Fed Destroyer)')
                .addComponent(NpcAIComponent, undefined)
                .addComponent(GovtComponent, { id: 128 })
                .addComponent(NpcCombatRoleComponent, 'military')
                .addComponent(ShipComponent, { id: 'nova:141' })
                .addComponent(MultiplayerData, { owner: 'server' })
                .addComponent(MovementPhysicsComponent, {
                    acceleration: 150,
                    maxVelocity: 220,
                    movementType: MovementType.INERTIAL,
                    turnRate: 2,
                })
                .addComponent(MovementStateComponent, {
                    position: new Position(SYSTEM_DEPARTURE_RADIUS + 50, 0),
                    velocity: new Vector(500, 0),
                    rotation: new Angle(Math.PI / 2),
                    accelerating: 1,
                    turning: 0,
                    turnBack: false,
                })
                .addComponent(JumpStateComponent, {
                    from: 'nova:130',
                    to: 'nova:129',
                    phase: 'departing',
                    phaseStartedAt: 0,
                    transitionAt: 500,
                    requiresAdjacency: false,
                    arrivalSoundPending: false,
                    createdAt: 0,
                });
            sourceWorld.entities.set('flagship-uuid', flagship);

            // Step source world: NpcJumpLifecycleSystem removes flagship and records transfer to nova:129
            sourceWorld.step();
            expect(sourceWorld.entities.has('flagship-uuid')).toBeFalse();

            // Player follows flagship into nova:129
            const destWorld = new World('dest-system-129');
            destWorld.resources.set(GameDataResource, gameData as never);
            destWorld.resources.set(SystemIdResource, 'nova:129');
            destWorld.resources.set(PlatformResource, 'node');
            destWorld.resources.set(TimeResource, time);
            destWorld.resources.set(EntityBudgetResource, createEntityBudget('modern'));
            await destWorld.addPlugin(DeltaPlugin);
            await destWorld.addPlugin(MovementPlugin);
            await destWorld.addPlugin(JumpPlugin);
            await destWorld.addPlugin(NpcSpawnPlugin);

            destWorld.step();
            await settle();
            destWorld.step();
            await settle();

            const followed = destWorld.entities.get('flagship-uuid');
            expect(followed).toBeDefined();
            expect(followed?.name).toBe('Valiant (Fed Destroyer)');
            expect(followed?.components.get(ShipComponent)?.id).toBe('nova:141');
            expect(followed?.components.get(GovtComponent)?.id).toBe(128);
            const mov = followed?.components.get(MovementStateComponent);
            expect(mov).toBeDefined();
            // Entered from West (since nova:130 is at [0,0] and nova:129 is at [100,0]), heading East (+x)
            expect(mov!.position.x).toBeLessThan(0);
            expect(mov!.velocity.x).toBeGreaterThan(0);
        });

    it('dead-reckons ship trajectories over time and transfers outbound ships when followed',
        async () => {
            const systems = new Map([
                ['nova:130', {
                    id: 'nova:130',
                    position: [0, 0] as const,
                    links: ['nova:129'],
                    planets: [],
                    avgShips: 2,
                    npcs: [],
                }],
                ['nova:129', {
                    id: 'nova:129',
                    position: [100, 0] as const,
                    links: ['nova:130'],
                    planets: [],
                    avgShips: 2,
                    npcs: [],
                }],
            ]);
            const gameData = {
                data: {
                    System: {
                        get: async (id: string) => systems.get(id),
                        getCached: (id: string) => systems.get(id),
                    },
                    Ship: {
                        get: async () => ({
                            ...getDefaultShipData(),
                            id: 'nova:133',
                            name: 'Starbridge',
                        }),
                    },
                },
            };
            resetSystemStateTracker(gameData);

            const worldA = new World('system-a');
            const eastRunner = new Entity('Eastbound Runner')
                .addComponent(NpcAIComponent, undefined)
                .addComponent(GovtComponent, { id: 128 })
                .addComponent(NpcCombatRoleComponent, 'civilian')
                .addComponent(ShipComponent, { id: 'nova:133' })
                .addComponent(MultiplayerData, { owner: 'server' })
                .addComponent(MovementStateComponent, {
                    position: new Position(400, 0),
                    velocity: new Vector(180, 0),
                    rotation: new Angle(Math.PI / 2),
                    accelerating: 1,
                    turning: 0,
                    turnBack: false,
                });
            const localCruiser = new Entity('Northbound Cruiser')
                .addComponent(NpcAIComponent, undefined)
                .addComponent(GovtComponent, { id: 128 })
                .addComponent(NpcCombatRoleComponent, 'military')
                .addComponent(ShipComponent, { id: 'nova:133' })
                .addComponent(MultiplayerData, { owner: 'server' })
                .addComponent(MovementStateComponent, {
                    position: new Position(0, -200),
                    velocity: new Vector(0, -100),
                    rotation: new Angle(0),
                    accelerating: 1,
                    turning: 0,
                    turnBack: false,
                });
            worldA.entities.set('east-runner', eastRunner);
            worldA.entities.set('north-cruiser', localCruiser);

            const t0 = 50_000;
            // Player jumps East to nova:129, following Eastbound Runner
            captureSystemNpcState(gameData as never, worldA, 'nova:130', 2, t0, 'nova:129');

            // Eastbound Runner was heading toward nova:129 (+x), so it was promoted
            // to a transfer into nova:129 and ceased to exist in nova:130's cached state!
            const cachedA = getCachedSystemState(gameData, 'nova:130', t0);
            expect(cachedA).toBeDefined();
            expect(cachedA!.ships.map(s => s.uuid)).toEqual(['north-cruiser']);

            // Advance nova:130 by 5 seconds: Northbound Cruiser dead-reckons 500 units North (-y)
            const advanced = advanceCachedSystemState(
                gameData as never,
                cachedA!,
                systems.get('nova:130') as never,
                t0 + 5_000,
            );
            expect(advanced.survivingShips.length).toBe(1);
            expect(advanced.survivingShips[0].position[0]).toBeCloseTo(0, 3);
            expect(advanced.survivingShips[0].position[1]).toBeCloseTo(-700, 3);
        });
});
