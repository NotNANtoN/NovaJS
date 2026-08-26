import * as t from 'io-ts';
import { Entities, UUID } from 'nova_ecs/arg_types';
import { AsyncSystem } from 'nova_ecs/async_system';
import { Component } from 'nova_ecs/component';
import { DeathEvent } from './death_plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Optional } from 'nova_ecs/optional';
import { PlatformResource } from './platform_plugin';
import { Plugin } from 'nova_ecs/plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { v4 as uuid } from 'uuid';
import { resourceId } from '../common/resource_id';
import { SingletonComponent } from 'nova_ecs/world';
import { MissionData } from 'novadatainterface/MissionData';
import { DudeData } from 'novadatainterface/DudeData';
import { GameDataResource } from './game_data_resource';
import {
    DisableOnZeroArmorComponent,
    DisabledComponent,
} from './death_plugin';
import {
    ChooseRandomTargetAI,
    DeathAISystem,
    FollowAI,
    GovtComponent,
    makeNpc,
    ShootAllWeaponsAI,
} from './npc_plugin';
import {
    PlayerState,
    PlayerStateComponent,
    PlayerStorePort,
} from './player_state';
import { PlayerStoreResource } from './player_state';
import { ShipComponent } from './ship_plugin';
import { TargetComponent } from './target_component';
import { SystemIdResource } from './system_id_resource';
import { MissionRuntime, MissionRuntimeResource } from './mission_plugin';
import { EntityBudgetResource, reserveEntity } from './entity_budget';
import { PlanetComponent } from './planet_plugin';
import { FinishJumpEvent } from './jump_plugin';

export interface MissionShipData {
    missionUuid: string;
    playerToken: string;
}

export const MissionShipComponent = new Component<MissionShipData>(
    'MissionShipComponent');

export interface MissionShipBehavior {
    behavior: number;
    playerUuid: string;
    activeAt: number;
    cloaked: boolean;
}

export const MissionShipBehaviorComponent = new Component<MissionShipBehavior>(
    'MissionShipBehaviorComponent');

export interface MissionShipStatus {
    disabledRecorded: boolean;
    observedRecorded: boolean;
}

export const MissionShipStatusComponent = new Component<MissionShipStatus>(
    'MissionShipStatusComponent');

const MissionPlayersQuery = new Query([
    UUID, MultiplayerData, PlayerStateComponent,
] as const, 'MissionPlayers');

const StellarTargetsQuery = new Query([
    UUID, MovementStateComponent, PlanetComponent,
] as const, 'MissionStellarTargets');

function sameId(a: string | undefined, b: string): boolean {
    return a !== undefined
        && (a === b || a.replace(/^.*:/, '') === b.replace(/^.*:/, ''));
}

export function missionShipAppearsInSystem(
    shipSystem: string | undefined,
    currentSystem: string,
): boolean {
    return shipSystem === '*' || sameId(shipSystem, currentSystem);
}

function missionIdFor(
    entry: {
        missionUuid?: string;
        missionId: string;
        acceptedDate?: number;
    },
): string {
    return entry.missionUuid ?? `${entry.missionId}:${entry.acceptedDate ?? 0}`;
}

function weighted<T extends { weight: number }>(
    values: readonly T[],
): T | undefined {
    const available = values.filter(value =>
        Number.isFinite(value.weight) && value.weight > 0);
    const total = available.reduce((sum, value) => sum + value.weight, 0);
    if (total <= 0) {
        return undefined;
    }
    let remaining = Math.random() * total;
    for (const value of available) {
        if (remaining < value.weight) {
            return value;
        }
        remaining -= value.weight;
    }
    return available[available.length - 1];
}

async function loadMission(
    gameData: import('novadatainterface/GameDataInterface').GameDataInterface,
    entry: { missionId: string; missionData?: unknown },
): Promise<MissionData | undefined> {
    if (entry.missionData && typeof entry.missionData === 'object') {
        return entry.missionData as MissionData;
    }
    try {
        return await gameData.data.Mission?.get(entry.missionId);
    } catch {
        return undefined;
    }
}

async function loadDude(
    gameData: import('novadatainterface/GameDataInterface').GameDataInterface,
    mission: MissionData,
    systemId: string,
): Promise<DudeData | undefined> {
    const dudeId = resourceId(mission.shipDude);
    try {
        const dude = await gameData.data.Dude?.get(dudeId);
        if (dude && dude.ships.length > 0) {
            return dude;
        }
    } catch {
        // Older GameData providers do not expose düde resources.
    }

    try {
        const system = await gameData.data.System.get(systemId);
        const entry = system.npcs.find(candidate =>
            sameId(candidate.id, dudeId));
        if (!entry) {
            return undefined;
        }
        return {
            id: entry.id,
            name: entry.id,
            prefix: entry.id.split(':')[0] ?? 'nova',
            aiType: 0,
            government: entry.government,
            flags: 0,
            infoTypes: 0,
            ships: entry.ships,
        };
    } catch {
        return undefined;
    }
}

function playerTokenFor(
    player: { owner: string },
    store: PlayerStorePort | undefined,
): string {
    return store?.getTokenForPeer(player.owner) ?? player.owner;
}

function findPlayer(
    players: readonly (readonly [
        string, { owner: string }, PlayerState
    ])[],
    token: string,
    store: PlayerStorePort | undefined,
): readonly [string, { owner: string }, PlayerState] | undefined {
    return players.find(([, multiplayer, state]) =>
        playerTokenFor(multiplayer, store) === token);
}

const MissionShipSpawnSystem = new AsyncSystem({
    name: 'MissionShipSpawn',
    args: [
        GameDataResource,
        SystemIdResource,
        PlatformResource,
        TimeResource,
        SingletonComponent,
        Entities,
        Optional(PlayerStoreResource),
        EntityBudgetResource,
    ] as const,
    exclusive: true,
    async step(
        gameData,
        systemId,
        platform,
        time,
        _singleton,
        entities,
        playerStore,
        budget,
    ) {
        if (platform !== 'node') {
            return;
        }
        const store = playerStore;
        const existing = new Set(
            [...entities].map(([, entity]) =>
                entity.components.get(MissionShipComponent))
                .filter((missionShip): missionShip is MissionShipData =>
                    missionShip !== undefined)
                .map(missionShip =>
                    `${missionShip.playerToken}:${missionShip.missionUuid}`));
        const players = [...entities].flatMap(([uuid, entity]) => {
            const multiplayer = entity.components.get(MultiplayerData);
            const state = entity.components.get(PlayerStateComponent);
            return multiplayer && state
                ? [[uuid, multiplayer, state] as const] : [];
        });

        for (const [playerUuid, multiplayer, state] of players) {
            const token = playerTokenFor(multiplayer, store);
            for (const entry of state.activeMissions) {
                if (entry.state !== 'active' || !entry.shipSystem
                    || !missionShipAppearsInSystem(
                        entry.shipSystem, systemId)) {
                    continue;
                }
                const mission = await loadMission(gameData, entry);
                if (!mission || mission.shipCount <= 0
                    || mission.shipGoal < 0) {
                    continue;
                }
                const missionUuid = missionIdFor(entry);
                if (entry.shipGoalProgress?.completed
                    || existing.has(`${token}:${missionUuid}`)) {
                    continue;
                }
                const dude = await loadDude(gameData, mission, systemId);
                const shipType = dude && weighted(dude.ships);
                if (!dude || !shipType) {
                    console.warn(
                        `Cannot spawn mission ${entry.missionId}: düde `
                        + `${mission.shipDude} has no ship types`);
                    continue;
                }

                for (let index = 0; index < mission.shipCount; index++) {
                    const selected = index === 0
                        ? shipType
                        : weighted(dude.ships);
                    if (!selected) {
                        continue;
                    }
                    try {
                        const shipData = await gameData.data.Ship.get(selected.id);
                        const ship = makeNpc(shipData);
                        // Modern mode prioritizes mission ships over cosmetic
                        // budgets; classic mode still preserves its hard cap.
                        if (!reserveEntity(budget, ship, 'ship', true)) {
                            break;
                        }
                        ship.components
                            .set(MissionShipComponent, {
                                missionUuid,
                                playerToken: token,
                            })
                            .set(MissionShipBehaviorComponent, {
                                behavior: mission.shipBehav,
                                playerUuid,
                                activeAt: mission.shipStart === 1
                                    ? time.time + 1_500 : time.time,
                                cloaked: mission.shipStart === 2,
                            })
                            .set(MissionShipStatusComponent, {
                                disabledRecorded: false,
                                observedRecorded: false,
                            })
                            .set(GovtComponent, { id: dude.government })
                            .set(MultiplayerData, { owner: 'server' });
                        if (mission.shipGoal === 1) {
                            ship.components.set(
                                DisableOnZeroArmorComponent, undefined);
                        }
                        entities.set(uuid(), ship);
                    } catch {
                        // Bad plug-in ship data should not prevent the rest
                        // of a mission fleet from appearing.
                    }
                }
                existing.add(`${token}:${missionUuid}`);
            }
        }
    },
});

const MissionShipBehaviorSystem = new System({
    name: 'MissionShipBehavior',
    after: [ChooseRandomTargetAI, FollowAI, ShootAllWeaponsAI],
    args: [
        MissionShipBehaviorComponent,
        MovementStateComponent,
        Optional(TargetComponent),
        Optional(DisabledComponent),
        TimeResource,
        Entities,
        StellarTargetsQuery,
    ] as const,
    step(behavior, movement, target, disabled, time, entities,
        stellarTargets) {
        if (behavior.activeAt > time.time) {
            movement.accelerating = 0;
            movement.velocity = movement.velocity.scale(0);
            if (target) {
                target.target = undefined;
            }
            return;
        }
        if (disabled || !entities.has(behavior.playerUuid)) {
            movement.accelerating = 0;
            movement.velocity = movement.velocity.scale(0);
            if (target) {
                target.target = undefined;
            }
            return;
        }

        if (behavior.behavior === 0) {
            // "Always attack the player", regardless of government
            // hostility or provocation.
            if (target) {
                target.target = behavior.playerUuid;
            }
            movement.turnTo = behavior.playerUuid;
            movement.accelerating = 1;
        } else if (behavior.behavior === 1) {
            // Protect the player by staying with them; the normal NPC target
            // is retained so the escort may still fire on enemies.
            movement.turnTo = behavior.playerUuid;
            movement.accelerating = 1;
        } else if (behavior.behavior === 2) {
            // Target the nearest stellar. Planet entities are the current
            // ECS representation of stellar objects; the ordinary weapon
            // systems can then drive the ship toward and fire at that target.
            const stellar = stellarTargets
                .filter(([stellarUuid]) => stellarUuid !== behavior.playerUuid)
                .sort((a, b) =>
                    a[1].position.subtract(movement.position).lengthSquared
                    - b[1].position.subtract(movement.position).lengthSquared)
                [0];
            if (stellar) {
                if (target) {
                    target.target = stellar[0];
                }
                movement.turnTo = stellar[0];
                movement.accelerating = 1;
            }
        }
    },
});

const MissionShipDeathSystem = new System({
    name: 'MissionShipGoalDeath',
    before: [DeathAISystem],
    events: [DeathEvent],
    args: [
        MissionShipComponent,
        MissionPlayersQuery,
        Optional(PlayerStoreResource),
        MissionRuntimeResource,
        PlatformResource,
    ] as const,
    step(missionShip, players, playerStore, runtime, platform) {
        if (platform !== 'node') {
            return;
        }
        const store = playerStore;
        const player = findPlayer(
            players, missionShip.playerToken, store);
        if (!player) {
            return;
        }
        void runtime.recordShipGoal(
            player[2], missionShip.missionUuid, 'destroyed');
    },
});

const MissionShipChaseOffSystem = new System({
    name: 'MissionShipGoalChaseOff',
    events: [FinishJumpEvent],
    args: [
        FinishJumpEvent,
        MissionPlayersQuery,
        Optional(PlayerStoreResource),
        MissionRuntimeResource,
        PlatformResource,
    ] as const,
    step(jump, players, playerStore, runtime, platform) {
        if (platform !== 'node') {
            return;
        }
        const missionShip = jump.entity.components.get(MissionShipComponent);
        if (!missionShip) {
            return;
        }
        const player = findPlayer(
            players, missionShip.playerToken, playerStore);
        if (!player) {
            return;
        }
        // EV Nova Bible, mïsn/ShipGoal 6: "Chase them off (either kill them
        // or scare the into jumping out of the system)."
        void runtime.recordShipGoal(
            player[2], missionShip.missionUuid, 'chasedOff');
    },
});

const MissionShipDisabledSystem = new System({
    name: 'MissionShipGoalDisabled',
    args: [
        MissionShipComponent,
        DisabledComponent,
        MissionShipStatusComponent,
        MissionPlayersQuery,
        Optional(PlayerStoreResource),
        MissionRuntimeResource,
        PlatformResource,
    ] as const,
    step(missionShip, _disabled, status, players, playerStore,
        runtime, platform) {
        if (platform !== 'node' || status.disabledRecorded) {
            return;
        }
        status.disabledRecorded = true;
        const store = playerStore;
        const player = findPlayer(
            players, missionShip.playerToken, store);
        if (player) {
            void runtime.recordShipGoal(
                player[2], missionShip.missionUuid, 'disabled');
        }
    },
});

const MissionShipObservationSystem = new System({
    name: 'MissionShipGoalObserve',
    args: [
        MissionShipComponent,
        MissionShipStatusComponent,
        MissionShipBehaviorComponent,
        MissionPlayersQuery,
        Optional(PlayerStoreResource),
        MissionRuntimeResource,
        SystemIdResource,
        PlatformResource,
    ] as const,
    step(missionShip, status, behavior, players, playerStore,
        runtime, systemId, platform) {
        if (platform !== 'node' || status.observedRecorded
            || behavior.cloaked) {
            return;
        }
        const store = playerStore;
        const player = findPlayer(
            players, missionShip.playerToken, store);
        if (!player || !sameId(player[2].currentSystem, systemId)) {
            return;
        }
        status.observedRecorded = true;
        void runtime.recordShipGoal(
            player[2], missionShip.missionUuid, 'observed');
    },
});

const MissionShipCleanupSystem = new System({
    name: 'MissionShipCleanup',
    args: [
        MissionShipComponent,
        UUID,
        MissionPlayersQuery,
        Optional(PlayerStoreResource),
        PlatformResource,
        Entities,
    ] as const,
    step(missionShip, shipUuid, players, playerStore, platform, entities) {
        if (platform !== 'node') {
            return;
        }
        const store = playerStore;
        const player = findPlayer(
            players, missionShip.playerToken, store);
        const active = player?.[2].activeMissions.some(entry =>
            entry.state === 'active'
            && (entry.missionUuid === missionShip.missionUuid
                || missionIdFor(entry)
                    === missionShip.missionUuid));
        if (!active) {
            entities.delete(shipUuid);
        }
    },
});

export const MissionShipsPlugin: Plugin = {
    name: 'MissionShipsPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(MissionShipComponent);
        world.addComponent(MissionShipBehaviorComponent);
        world.addComponent(MissionShipStatusComponent);
        deltaMaker.addComponent(MissionShipComponent, {
            componentType: t.type({
                missionUuid: t.string,
                playerToken: t.string,
            }),
        });
        world.addSystem(MissionShipSpawnSystem);
        world.addSystem(MissionShipBehaviorSystem);
        // PlayerStoreResource is deliberately absent from browser and
        // temporary outfit-builder worlds. These systems use it as a
        // server-only authority, so do not install queries that require it
        // in those worlds.
        if (world.resources.has(PlayerStoreResource)) {
            world.addSystem(MissionShipDeathSystem);
            world.addSystem(MissionShipChaseOffSystem);
            world.addSystem(MissionShipDisabledSystem);
            world.addSystem(MissionShipObservationSystem);
            world.addSystem(MissionShipCleanupSystem);
        } else {
            world.removeSystem(MissionShipSpawnSystem);
            world.removeSystem(MissionShipBehaviorSystem);
        }
    },
    remove(world) {
        world.removeSystem(MissionShipSpawnSystem);
        world.removeSystem(MissionShipBehaviorSystem);
        world.removeSystem(MissionShipDeathSystem);
        world.removeSystem(MissionShipChaseOffSystem);
        world.removeSystem(MissionShipDisabledSystem);
        world.removeSystem(MissionShipObservationSystem);
        world.removeSystem(MissionShipCleanupSystem);
    },
};
