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
} from './jump_plugin';
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
});
