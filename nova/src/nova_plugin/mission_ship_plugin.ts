import * as t from 'io-ts';
import { Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { AsyncSystem } from 'nova_ecs/async_system';
import { Component } from 'nova_ecs/component';
import { plainSnapshot } from 'nova_ecs/draft_snapshot';
import { Entity } from 'nova_ecs/entity';
import { DeathEvent } from './death_plugin';
import { BoardingOutcomeEvent } from './boarding_plugin';
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
    ActiveMission,
    decodePlayerState,
    PlayerState,
    PlayerStateComponent,
    PlayerStorePort,
} from './player_state';
import { MissionGoalEvent } from './mission_goals';
import { PersBecomesSpecialShipComponent, PersComponent } from './pers_plugin';
import { noteServerMissionBits, takePlayerStateEcho } from './combat_resources';
import { PlayerStoreResource } from './player_state';
import { ShipComponent } from './ship_plugin';
import { TargetComponent } from './target_component';
import { SystemIdResource } from './system_id_resource';
import { MissionRuntime, MissionRuntimeResource } from './mission_plugin';
import { EntityBudgetResource, reserveEntity } from './entity_budget';
import { PlanetComponent } from './planet_plugin';
import { areSystemsSameOrVariants, FinishJumpEvent, SystemLookup } from './jump_plugin';

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

export function missionShipSystemForEntry(
    entry: ActiveMission,
    mission?: MissionData,
): string | undefined {
    if (entry.shipSystem) {
        return entry.shipSystem;
    }
    const syst = entry.missionData?.shipSyst ?? mission?.shipSyst;
    if (syst === -6) {
        return '*';
    }
    if (syst !== undefined && syst >= 128 && syst <= 2175) {
        return resourceId(syst);
    }
    return undefined;
}

export function missionShipAppearsInSystem(
    shipSystem: string | undefined,
    currentSystem: string,
    systems?: SystemLookup,
): boolean {
    if (!shipSystem) return false;
    if (shipSystem === '*' || sameId(shipSystem, currentSystem)) {
        return true;
    }
    if (systems && areSystemsSameOrVariants(shipSystem, currentSystem, systems)) {
        return true;
    }
    return false;
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
    dudeNumber: number,
    systemId: string,
): Promise<DudeData | undefined> {
    if (!dudeNumber || dudeNumber <= 0) {
        return undefined;
    }
    const dudeId = resourceId(dudeNumber);
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
        if (entry) {
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
        }
    } catch {
        // Continue to direct ship fallback
    }

    try {
        const ship = await gameData.data.Ship.get(dudeId);
        if (ship) {
            return {
                id: dudeId,
                name: ship.name,
                prefix: dudeId.split(':')[0] ?? 'nova',
                aiType: 1, // Hostile outlaw AI
                government: 130, // Pirate/outlaw government
                flags: 0,
                infoTypes: 0,
                ships: [{ id: dudeId, weight: 1 }],
            };
        }
    } catch {
        return undefined;
    }
    return undefined;
}

function playerTokenFor(
    player: { owner: string },
    store: PlayerStorePort | undefined,
): string {
    return store?.getTokenForPeer(player.owner) ?? player.owner;
}

/**
 * Read everything the spawn loop needs out of the world up front, detached
 * from the component drafts it came from.
 *
 * The loop awaits mission, düde, and ship data. Each await lets the world step
 * again, which revokes any draft read beforehand and makes the next touch of
 * it throw — which used to take the whole server process down.
 */
export function collectMissionSpawnCandidates(
    entities: Iterable<readonly [string, Entity]>,
    store: PlayerStorePort | undefined,
    systemId: string,
    systems?: SystemLookup,
): Array<{
    playerUuid: string,
    token: string,
    missions: PlayerState['activeMissions'],
}> {
    return [...entities].flatMap(([uuid, entity]) => {
        const multiplayer = entity.components.get(MultiplayerData);
        const state = entity.components.get(PlayerStateComponent);
        if (!multiplayer || !state) {
            return [];
        }
        return [{
            playerUuid: uuid,
            token: playerTokenFor(multiplayer, store),
            missions: state.activeMissions
                .filter(entry => {
                    if (entry.state !== 'active') return false;
                    const shipSyst = missionShipSystemForEntry(entry);
                    return Boolean(shipSyst && missionShipAppearsInSystem(
                        shipSyst, systemId, systems));
                })
                .map(entry => {
                    const snap = plainSnapshot(entry);
                    if (!snap.shipSystem) {
                        snap.shipSystem = missionShipSystemForEntry(entry);
                    }
                    return snap;
                }),
        }];
    });
}

function activeEntryKey(entry: ActiveMission): string {
    return entry.missionUuid ?? `${entry.missionId}:${entry.acceptedDate ?? 0}`;
}

function applyListDelta<T>(target: T[], before: readonly T[],
    after: readonly T[]): T[] {
    const added = after.filter(value => !before.includes(value));
    const removed = before.filter(value => !after.includes(value));
    return [...target.filter(value => !removed.includes(value)),
        ...added.filter(value => !target.includes(value))];
}

/**
 * Apply only what a detached goal recording changed onto the pilot's current
 * state. Anything else the owner changed meanwhile (the owner keeps writing
 * its PlayerState while mission data loads) is preserved.
 */
export function applyGoalRecordingDelta(
    current: PlayerState,
    before: PlayerState,
    after: PlayerState,
): PlayerState {
    const next = decodePlayerState(plainSnapshot(current));
    if (next._tag === 'Left') {
        throw new Error('Cannot merge goal progress into invalid player state');
    }
    const state = next.right;
    for (let bit = 0; bit < after.missionBits.length; bit++) {
        if (after.missionBits[bit] !== before.missionBits[bit]) {
            state.missionBits[bit] = after.missionBits[bit];
        }
    }
    const beforeEntries = new Map(before.activeMissions.map(entry =>
        [activeEntryKey(entry), JSON.stringify(entry)] as const));
    const afterKeys = new Set(after.activeMissions.map(activeEntryKey));
    state.activeMissions = state.activeMissions.filter(entry =>
        !beforeEntries.has(activeEntryKey(entry))
        || afterKeys.has(activeEntryKey(entry)));
    for (const entry of after.activeMissions) {
        const key = activeEntryKey(entry);
        const previous = beforeEntries.get(key);
        if (previous === JSON.stringify(entry)) continue;
        const index = state.activeMissions.findIndex(candidate =>
            activeEntryKey(candidate) === key);
        if (index >= 0) {
            state.activeMissions[index] = entry;
        } else if (previous === undefined) {
            state.activeMissions.push(entry);
        }
    }
    if (JSON.stringify(after.holds) !== JSON.stringify(before.holds)) {
        state.holds = after.holds;
    }
    state.credits = Math.max(0, state.credits + after.credits - before.credits);
    state.gameDate += after.gameDate - before.gameDate;
    const records = { ...state.legalRecords };
    for (const govt of new Set([
        ...Object.keys(before.legalRecords ?? {}),
        ...Object.keys(after.legalRecords ?? {}),
    ])) {
        const change = (after.legalRecords?.[govt] ?? 0)
            - (before.legalRecords?.[govt] ?? 0);
        if (change !== 0) records[govt] = (records[govt] ?? 0) + change;
    }
    state.legalRecords = records;
    state.activeRanks = applyListDelta(
        state.activeRanks, before.activeRanks, after.activeRanks);
    state.destroyedStellars = applyListDelta(state.destroyedStellars,
        before.destroyedStellars, after.destroyedStellars);
    state.exploredSystems = applyListDelta(state.exploredSystems,
        before.exploredSystems, after.exploredSystems);
    return state;
}

type GoalRecorder = Pick<MissionRuntime, 'recordShipGoal'>;
const goalQueues = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * Record a special-ship goal without holding a step's Immer draft across the
 * mission-data await. Recordings for one pilot run in order, each starting
 * from the entity's then-current state, and the result is written back onto
 * whatever PlayerState the entity carries once the await finishes.
 */
export function recordShipGoalDetached(
    runtime: GoalRecorder,
    entities: ReadonlyMap<string, Entity>,
    playerUuid: string,
    missionUuid: string,
    event: MissionGoalEvent,
): Promise<void> {
    let queues = goalQueues.get(entities);
    if (!queues) {
        queues = new Map();
        goalQueues.set(entities, queues);
    }
    const previous = queues.get(playerUuid) ?? Promise.resolve();
    const work = async () => {
        const live = entities.get(playerUuid)
            ?.components.get(PlayerStateComponent);
        if (!live) return;
        const decoded = decodePlayerState(plainSnapshot(live));
        if (decoded._tag === 'Left') return;
        const before = decodePlayerState(plainSnapshot(live));
        if (before._tag === 'Left') return;
        const working = decoded.right;
        await runtime.recordShipGoal(working, missionUuid, event);
        if (JSON.stringify(working) === JSON.stringify(before.right)) return;
        const entity = entities.get(playerUuid);
        const current = entity?.components.get(PlayerStateComponent);
        if (!entity || !current) return;
        entity.components.set(PlayerStateComponent,
            applyGoalRecordingDelta(current, before.right, working));
        const owner = entity.components.get(MultiplayerData)?.owner;
        if (owner) {
            noteServerMissionBits(owner, working.missionBits
                .map((value, bit) => [bit, value] as const)
                .filter(([bit, value]) => before.right.missionBits[bit] !== value));
        }
    };
    const next = previous.then(work).catch(error => {
        console.error(`Could not record mission ship goal '${event}'`, error);
    });
    queues.set(playerUuid, next);
    void next.finally(() => {
        if (queues!.get(playerUuid) === next) queues!.delete(playerUuid);
    });
    return next;
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

/**
 * përs Flags 0x0040: the përs whose LinkMission was accepted becomes the
 * mission's single special ship, keeping its hull, instead of a new ship
 * appearing beside it (e.g. the Refuel Trader missions 141/650-652).
 */
export function adoptPersSpecialShip(
    entities: Map<string, Entity>,
    missionUuid: string,
    token: string,
    playerUuid: string,
    mission: Pick<MissionData, 'shipGoal' | 'shipBehav' | 'shipStart'>,
    now: number,
): boolean {
    for (const [, entity] of entities) {
        const tag = entity.components.get(PersBecomesSpecialShipComponent);
        if (!tag || tag.missionUuid !== missionUuid) continue;
        entity.components.delete(PersBecomesSpecialShipComponent);
        entity.components.delete(PersComponent);
        entity.components
            .set(MissionShipComponent, { missionUuid, playerToken: token })
            .set(MissionShipBehaviorComponent, {
                behavior: mission.shipBehav >= 0 ? mission.shipBehav : -1,
                playerUuid,
                activeAt: now,
                cloaked: false,
            })
            .set(MissionShipStatusComponent, {
                disabledRecorded: false,
                observedRecorded: false,
            });
        if (mission.shipGoal === 1) {
            entity.components.set(DisableOnZeroArmorComponent, undefined);
        }
        return true;
    }
    return false;
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
        const players = collectMissionSpawnCandidates(
            entities, store, systemId, gameData.data.System);

        for (const { playerUuid, token, missions } of players) {
            for (const entry of missions) {
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
                if (mission.shipCount === 1 && adoptPersSpecialShip(
                    entities, missionUuid, token, playerUuid, mission, time.time)) {
                    existing.add(`${token}:${missionUuid}`);
                    continue;
                }
                const dude = await loadDude(gameData, mission.shipDude, systemId);
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
                        const outlawGovt = mission.shipGoal === 1 ? 137 : dude.government;
                        const outlawBehav = mission.shipBehav >= 0
                            ? mission.shipBehav
                            : (mission.shipGoal === 1 ? 2 : 0);
                        ship.components
                            .set(MissionShipComponent, {
                                missionUuid,
                                playerToken: token,
                            })
                            .set(MissionShipBehaviorComponent, {
                                behavior: outlawBehav,
                                playerUuid,
                                activeAt: mission.shipStart === 1
                                    ? time.time + 1_500 : time.time,
                                cloaked: mission.shipStart === 2,
                            })
                            .set(MissionShipStatusComponent, {
                                disabledRecorded: false,
                                observedRecorded: false,
                            })
                            .set(GovtComponent, { id: outlawGovt })
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

                // Spawn auxiliary fleet (ambushers, escorts, or pirate wingmen)
                if (mission.auxShipCount > 0 && mission.auxShipDude > 0
                    && !existing.has(`${token}:${missionUuid}:aux`)) {
                    const auxSystemMatches = mission.auxShipSyst <= 0
                        || mission.auxShipSyst === -1
                        || missionShipAppearsInSystem(resourceId(mission.auxShipSyst), systemId);
                    if (auxSystemMatches) {
                        const auxDude = await loadDude(gameData, mission.auxShipDude, systemId);
                        const auxShipType = auxDude && weighted(auxDude.ships);
                        if (auxDude && auxShipType) {
                            for (let aIdx = 0; aIdx < mission.auxShipCount; aIdx++) {
                                const sel = aIdx === 0 ? auxShipType : weighted(auxDude.ships);
                                if (!sel) continue;
                                try {
                                    const aShipData = await gameData.data.Ship.get(sel.id);
                                    const aShip = makeNpc(aShipData);
                                    if (!reserveEntity(budget, aShip, 'ship', true)) {
                                        break;
                                    }
                                    aShip.components
                                        .set(MissionShipComponent, {
                                            missionUuid,
                                            playerToken: token,
                                        })
                                        .set(MissionShipBehaviorComponent, {
                                            // For escort missions (goal 3), aux ships are the ambushers attacking the convoy!
                                            behavior: mission.shipGoal === 3 ? 1 : mission.shipBehav,
                                            playerUuid,
                                            activeAt: time.time + 1000,
                                            cloaked: false,
                                        })
                                        .set(MissionShipStatusComponent, {
                                            disabledRecorded: false,
                                            observedRecorded: false,
                                        })
                                        .set(GovtComponent, { id: auxDude.government })
                                        .set(MultiplayerData, { owner: 'server' });
                                    entities.set(uuid(), aShip);
                                } catch {
                                    // Ignore bad ship data
                                }
                            }
                            existing.add(`${token}:${missionUuid}:aux`);
                        }
                    }
                }
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
        Entities,
    ] as const,
    step(missionShip, players, playerStore, runtime, platform, entities) {
        if (platform !== 'node') {
            return;
        }
        const store = playerStore;
        const player = findPlayer(
            players, missionShip.playerToken, store);
        if (!player) {
            return;
        }
        void recordShipGoalDetached(runtime, entities, player[0],
            missionShip.missionUuid, 'destroyed');
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
        SingletonComponent,
        Entities,
    ] as const,
    step(jump, players, playerStore, runtime, platform, _singleton, entities) {
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
        void recordShipGoalDetached(runtime, entities, player[0],
            missionShip.missionUuid, 'chasedOff');
    },
});

export const MissionShipBoardedSystem = new System({
    name: 'MissionShipGoalBoarded',
    events: [BoardingOutcomeEvent],
    args: [
        BoardingOutcomeEvent,
        Entities,
        MissionPlayersQuery,
        Optional(PlayerStoreResource),
        MissionRuntimeResource,
        PlatformResource,
    ] as const,
    step(outcome, entities, players, playerStore, runtime, platform) {
        if (platform !== 'node') {
            return;
        }
        const targetEntity = entities.get(outcome.target);
        const missionShip = targetEntity?.components.get(MissionShipComponent);
        if (!missionShip) {
            return;
        }
        const player = findPlayer(players, missionShip.playerToken, playerStore);
        if (player) {
            void recordShipGoalDetached(runtime, entities, player[0],
                missionShip.missionUuid, 'boarded');
        }
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
        Entities,
    ] as const,
    step(missionShip, _disabled, status, players, playerStore,
        runtime, platform, entities) {
        if (platform !== 'node' || status.disabledRecorded) {
            return;
        }
        status.disabledRecorded = true;
        const store = playerStore;
        const player = findPlayer(
            players, missionShip.playerToken, store);
        if (player) {
            void recordShipGoalDetached(runtime, entities, player[0],
                missionShip.missionUuid, 'disabled');
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
        Entities,
    ] as const,
    step(missionShip, status, behavior, players, playerStore,
        runtime, systemId, platform, entities) {
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
        void recordShipGoalDetached(runtime, entities, player[0],
            missionShip.missionUuid, 'observed');
    },
});

/**
 * When an owner's stale PlayerState write had server-recorded goal progress
 * merged back in, replace the component so the corrected state is sent to
 * the owner instead of silently becoming the replication baseline.
 */
const MissionProgressEchoSystem = new System({
    name: 'MissionProgressEcho',
    args: [MultiplayerData, PlayerStateComponent, GetEntity, PlatformResource] as const,
    step(multiplayer, state, entity, platform) {
        if (platform !== 'node' || !takePlayerStateEcho(multiplayer.owner)) {
            return;
        }
        const copy = decodePlayerState(plainSnapshot(state));
        if (copy._tag === 'Right') {
            entity.components.set(PlayerStateComponent, copy.right);
        }
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
            world.addSystem(MissionShipBoardedSystem);
            world.addSystem(MissionShipChaseOffSystem);
            world.addSystem(MissionShipDisabledSystem);
            world.addSystem(MissionShipObservationSystem);
            world.addSystem(MissionShipCleanupSystem);
            world.addSystem(MissionProgressEchoSystem);
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
        world.removeSystem(MissionProgressEchoSystem);
    },
};
