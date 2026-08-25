import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { GameDataResource } from './game_data_resource';
import {
    GovtComponent,
    NpcPlugin,
    ChooseRandomTargetComponent,
    NpcCombatRoleComponent,
} from './npc_plugin';
import {
    DamagedEvent,
    DeathEvent,
    DeathPlugin,
    PlayerDeathComponent,
} from './death_plugin';
import { ArmorComponent, ShieldComponent } from './health_plugin';
import {
    ProvocationResource,
    clearProvocation,
    createProvocationState,
    isProvoked,
    isPersonallyProvoked,
    pruneProvocations,
    recordDamage,
} from './npc_hostility';
import { PlatformResource } from './platform_plugin';
import { Stat } from './stat';
import { TargetComponent } from './target_component';
import { makeNpc } from './npc_plugin';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import {
    GovernmentData,
    GovernmentRelationResource,
} from './govt_relations';
import { Position } from 'nova_ecs/datatypes/position';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Vector } from 'nova_ecs/datatypes/vector';
import { ShipComponent } from './ship_plugin';
import { PlayerShipSelector } from './player_ship_plugin';

function government(
    id: number,
    classes: number[],
    allies: number[] = [],
    enemies: number[] = [],
): GovernmentData {
    return {
        id: `nova:${id}`,
        name: `Government ${id}`,
        prefix: '',
        classes,
        allies,
        enemies,
    };
}

function movement(x: number) {
    return {
        accelerating: 0,
        position: new Position(x, 0),
        rotation: new Angle(0),
        turnBack: false,
        turning: 0,
        velocity: new Vector(0, 0),
    };
}

describe('NPC hostility', () => {
    it('prunes damage accumulators for deleted victims', () => {
        const state = createProvocationState();
        const activeEntities = new Set(['attacker']);

        for (let i = 0; i < 10_000; i++) {
            recordDamage(
                state,
                128,
                `dead-victim-${i}`,
                'attacker',
                1,
                1,
                i,
            );
        }

        pruneProvocations(state, activeEntities, 10_000);

        expect(state.damageByVictimAttacker.size).toBe(0);
        expect(state.attackersByVictimGovernment.get(128))
            .toEqual(new Set(['attacker']));
    });

    it('clears all damage records that reference an entity', () => {
        const state = createProvocationState();
        recordDamage(state, 128, 'victim', 'player', 3, 100, 0);
        recordDamage(state, 128, 'player', 'attacker', 3, 100, 0);
        clearProvocation(state, 'player');

        expect(state.damageByVictimAttacker.size).toBe(0);
    });

    it('makes the victim shoot back before the faction is provoked', async () => {
        const gameData = {
            data: {
                Govt: {
                    get: async () => government(128, [1]),
                },
            },
        } as unknown as GameDataInterface;

        const world = new World('npc-retaliation-test');
        world.resources.set(PlatformResource, 'node');
        world.resources.set(GameDataResource, gameData);
        world.resources.set(TimeResource, {
            time: 0,
            delta_ms: 0,
            delta_s: 0,
            frame: 0,
        });
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);
        await world.addPlugin(NpcPlugin);

        world.entities.set('player', new Entity('player')
            .addComponent(ShipComponent, { id: 'nova:128' })
            .addComponent(MovementStateComponent, movement(10))
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(MultiplayerData, { owner: 'player' }));

        const victim = makeNpc({
            ...getDefaultShipData(),
            id: 'nova:128',
            name: 'victim',
        })
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(GovtComponent, { id: 128 })
            .addComponent(TargetComponent, { target: undefined });
        victim.components.set(ChooseRandomTargetComponent, { interval: 5_000 });
        victim.components.set(NpcCombatRoleComponent, 'civilian');
        victim.components.set(ShieldComponent, new Stat({
            current: 500, recharge: 0, max: 500,
        }));
        victim.components.set(ArmorComponent, new Stat({
            current: 500, recharge: 0, max: 500,
        }));
        world.entities.set('victim', victim);

        const bystander = makeNpc({
            ...getDefaultShipData(),
            id: 'nova:128',
            name: 'bystander',
        })
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(GovtComponent, { id: 128 })
            .addComponent(TargetComponent, { target: undefined });
        bystander.components.set(
            ChooseRandomTargetComponent, { interval: 0 });
        bystander.components.set(NpcCombatRoleComponent, 'civilian');
        world.entities.set('bystander', bystander);

        // Far below the government provocation threshold.
        world.emitNow(DamagedEvent, {
            damage: {
                shield: 1,
                armor: 0,
                ionization: 0,
                ionizationColor: 0,
                passThroughShield: 0,
                knockback: 0,
            },
            damager: 'player',
        }, ['victim']);

        expect(world.resources.get(ProvocationResource)!
            .attackersByVictimGovernment.size).toBe(0);
        expect(victim.components.get(TargetComponent)!.target).toBe('player');
        expect(bystander.components.get(TargetComponent)!.target)
            .toBeUndefined();

        // The retaliation survives the AI's own target evaluation instead of
        // being cleared because the faction is not hostile yet.
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
            world.step();
        }
        expect(victim.components.get(TargetComponent)!.target).toBe('player');
        expect(bystander.components.get(TargetComponent)!.target)
            .toBeUndefined();

        // A stale propagated target must not survive the normal retarget
        // interval when it points at the same government.
        bystander.components.get(TargetComponent)!.target = 'victim';
        bystander.components.get(ChooseRandomTargetComponent)!.nextTime = 60_000;
        world.step();
        expect(bystander.components.get(TargetComponent)!.target)
            .toBeUndefined();

        // Even sustained damage against a trader remains that trader's
        // personal fight; broad civilian governments do not join in.
        world.emitNow(DamagedEvent, {
            damage: {
                shield: 100,
                armor: 0,
                ionization: 0,
                ionizationColor: 0,
                passThroughShield: 0,
                knockback: 0,
            },
            damager: 'player',
        }, ['victim']);
        world.step();
        expect(world.resources.get(ProvocationResource)!
            .attackersByVictimGovernment.size).toBe(0);
        expect(isPersonallyProvoked(
            world.resources.get(ProvocationResource)!,
            'victim',
            'player',
        )).toBe(true);
        expect(bystander.components.get(TargetComponent)!.target)
            .toBeUndefined();

        // Deleted threats are cleared immediately, even while the direct
        // retaliation hold interval is still active.
        world.entities.delete('player');
        world.step();
        expect(victim.components.get(TargetComponent)!.target).toBeUndefined();

        const friendly = makeNpc({
            ...getDefaultShipData(),
            id: 'nova:128',
            name: 'friendly',
        })
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(GovtComponent, { id: 128 })
            .addComponent(TargetComponent, { target: undefined });
        world.entities.set('friendly', friendly);
        world.emitNow(DamagedEvent, {
            damage: {
                shield: 100,
                armor: 0,
                ionization: 0,
                ionizationColor: 0,
                passThroughShield: 0,
                knockback: 0,
            },
            damager: 'friendly',
        }, ['victim']);
        expect(victim.components.get(TargetComponent)!.target).toBeUndefined();
        expect(isPersonallyProvoked(
            world.resources.get(ProvocationResource)!,
            'victim',
            'friendly',
        )).toBe(false);
    });

    it('only provokes the victim faction and allies after sustained damage', async () => {
        const governments = new Map<string, GovernmentData>([
            ['nova:128', government(128, [1])],
            ['nova:129', government(129, [2], [1])],
            ['nova:130', government(130, [3])],
            ['nova:131', government(131, [9], [], [1])],
        ]);
        const gameData = {
            data: {
                Govt: {
                    get: async (id: string) => {
                        const result = governments.get(id);
                        if (!result) {
                            throw new Error(`Missing government ${id}`);
                        }
                        return result;
                    },
                },
            },
        } as unknown as GameDataInterface;

        const world = new World('npc-hostility-test');
        world.resources.set(PlatformResource, 'node');
        world.resources.set(GameDataResource, gameData);
        world.resources.set(TimeResource, {
            time: 0,
            delta_ms: 0,
            delta_s: 0,
            frame: 0,
        });
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);
        await world.addPlugin(NpcPlugin);

        const player = new Entity('player')
            .addComponent(ShipComponent, { id: 'nova:128' })
            .addComponent(MovementStateComponent, movement(10))
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(MultiplayerData, { owner: 'player' });
        world.entities.set('player', player);

        const addNpc = (uuid: string, id: number, x: number) => {
            const npc = makeNpc({
                ...getDefaultShipData(),
                id: `nova:${id}`,
                name: uuid,
            })
                .addComponent(MultiplayerData, { owner: 'server' })
                .addComponent(GovtComponent, { id })
                .addComponent(TargetComponent, { target: undefined });
            npc.components.set(ChooseRandomTargetComponent, { interval: 0 });
            npc.components.set(NpcCombatRoleComponent, 'military');
            npc.components.set(ShieldComponent, new Stat({
                current: 500, recharge: 0, max: 500,
            }));
            npc.components.set(ArmorComponent, new Stat({
                current: 500, recharge: 0, max: 500,
            }));
            npc.components.get(MovementStateComponent)!.position = new Position(x, 0);
            world.entities.set(uuid, npc);
            return npc;
        };

        const victim = addNpc('victim', 128, 0);
        const ally = addNpc('ally', 129, 100);
        const neutral = addNpc('neutral', 130, 200);
        const naturalEnemy = addNpc('natural-enemy', 131, 300);
        expect(ally.components.get(NpcCombatRoleComponent)).toBe('military');

        world.emitNow(DamagedEvent, {
            damage: {
                shield: 20,
                armor: 0,
                ionization: 0,
                ionizationColor: 0,
                passThroughShield: 0,
                knockback: 0,
            },
            damager: 'player',
        }, ['victim']);
        world.step();
        expect(world.resources.get(ProvocationResource)!
            .attackersByVictimGovernment.size).toBe(0);

        world.emitNow(DamagedEvent, {
            damage: {
                shield: 10,
                armor: 0,
                ionization: 0,
                ionizationColor: 0,
                passThroughShield: 0,
                knockback: 0,
            },
            damager: 'player',
        }, ['victim']);
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
            world.step();
        }

        const provocations = world.resources.get(ProvocationResource)!;
        expect(isProvoked(
            provocations, 128, 'player',
            () => 'neutral',
        )).toBe(true);
        const relations = world.resources.get(GovernmentRelationResource)!;
        expect(relations.relation(128, 129))
            .withContext('relations remain directional')
            .toBe('neutral');
        expect(relations.relation(129, 128))
            .withContext('military actor recognizes the victim as an ally')
            .toBe('ally');
        expect(isProvoked(
            provocations,
            129,
            'player',
            (actor, victimGovernment) =>
                relations.relation(actor, victimGovernment),
        )).withContext('ally sees verified external provocation').toBe(true);
        expect(victim.components.get(TargetComponent)!.target)
            .withContext('direct military victim')
            .toBe('player');
        expect(ally.components.get(TargetComponent)!.target)
            .withContext('formal military ally')
            .toBe('player');
        expect(neutral.components.get(TargetComponent)!.target).not.toBe('player');
        expect(naturalEnemy.components.get(TargetComponent)!.target)
            .toBe('victim');

        const time = world.resources.get(TimeResource)!;
        world.emitNow(DeathEvent, time, ['player']);
        world.step();
        expect(player.components.has(PlayerDeathComponent)).toBe(true);
        expect(isProvoked(
            world.resources.get(ProvocationResource)!,
            128,
            'player',
            () => 'neutral',
        )).toBe(false);

        world.emitNow(DamagedEvent, {
            damage: {
                shield: 100,
                armor: 100,
                ionization: 0,
                ionizationColor: 0,
                passThroughShield: 0,
                knockback: 0,
            },
            damager: 'victim',
            fromExplosion: true,
        }, ['ally']);
        expect(world.resources.get(ProvocationResource)!
            .attackersByVictimGovernment.size).toBe(0);

        time.time += 3_000;
        world.step();
        expect(player.components.has(PlayerDeathComponent)).toBe(false);
        expect(isProvoked(
            world.resources.get(ProvocationResource)!,
            128,
            'player',
            () => 'neutral',
        )).toBe(false);

        time.time += 60_000;
        world.step();
        expect(isProvoked(
            world.resources.get(ProvocationResource)!,
            128,
            'player',
            () => 'neutral',
        )).toBe(false);
    });
});
