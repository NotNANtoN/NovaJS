import * as t from 'io-ts';
import { Entities, GetEntity, GetWorld, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { CombatAuthority, CombatAuthorityComponent, bindCombatOwner, combatLedger,
    makePlayerDataWithCombatResources as makePlayerData } from './combat_resources';
import { ShipComponent } from './ship_plugin';
import { OutfitsStateComponent } from './outfit_plugin';
import { ServerEnergyTransferSystem } from './energy_transfer_plugin';
import { CloakEnergyDrainSystem } from './cloaking_plugin';
import { Entity } from "nova_ecs/entity";
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from "nova_ecs/plugin";
import {
    CommunicatorResource,
    multiplayer,
    MultiplayerData,
    MultiplayerPhase,
    replicationPolicies,
} from "nova_ecs/plugins/multiplayer_plugin";
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { Subscription } from 'rxjs';
import { CommunicatorServer } from '../communication/CommunicatorServer';
import { GameDataResource } from "./game_data_resource";
import { makeSystem } from './make_system';
import { MultiRoomResource, SystemComponent } from "./nova_plugin";
import {
    CompatibilityProfile,
    CompatibilityProfileResource,
} from './entity_budget';
import {
    PersistentPlayerState,
    PlayerState,
    PlayerData as PlayerDataCodec,
    PlayerRevisionConflictError,
    PlayerStateComponent,
    PlayerStorePort,
    PlayerStoreResource,
    toPersistentPlayerState,
} from './player_state';
import {
    summarizeSnapshots,
} from './player_data_projection';

import { SystemIdResource } from './system_id_resource';

// Kept exported here for compatibility with code that used the original
// server-plugin stub. The codec itself is browser-safe and lives with state.
export const PlayerData = PlayerDataCodec;
export type PlayerData = t.TypeOf<typeof PlayerDataCodec>;

export const RemovedPeerEvent = new EcsEvent<string>('RemovedPeerEvent');
const PlayerEntitiesQuery = new Query([
    MultiplayerData, UUID, Optional(PlayerStateComponent), Optional(CombatAuthorityComponent), GetEntity,
] as const);
const PlayerPersistenceEntitiesQuery = new Query([
    MultiplayerData, UUID, GetEntity, PlayerStateComponent,
] as const);

interface PlayerStatePersistenceRecord {
    readonly token: string;
    /**
     * Revision this session last wrote. Presenting it on the next save makes
     * the write conditional, so a session that has fallen behind - a pilot
     * reconnecting while the previous one still flushes - cannot overwrite
     * newer progress.
     */
    revision?: number;
    pending?: Promise<void>;
    queued?: PersistentPlayerState;
    conflicted?: boolean;
    onRevision?: (revision: number) => void;
}

const flightPersistence = new WeakMap<object, PlayerStatePersistenceRecord>();
function flightRecordFor(token: string, authority: { storeRevision?: number } | undefined,
    previous?: PlayerStatePersistenceRecord): PlayerStatePersistenceRecord {
    if (!authority) return previous?.token === token ? previous : { token };
    let record = flightPersistence.get(authority);
    if (!record) {
        record = { token, revision: authority.storeRevision,
            onRevision: revision => { authority.storeRevision = Math.max(authority.storeRevision ?? 0, revision); } };
        flightPersistence.set(authority, record);
    }
    return record;
}

/**
 * Persists a pilot's state, dropping the write when the store has already
 * moved past the revision this session last saw. Returns the revision to
 * remember for the next write.
 */
async function saveConditionally(
    playerStore: PlayerStorePort,
    token: string,
    state: PersistentPlayerState,
    expectedRevision: number | undefined,
): Promise<number | undefined> {
    try {
        const saved = await (playerStore.saveFlightState
            ? playerStore.saveFlightState(token, state, expectedRevision)
            : playerStore.save(token, state, undefined, expectedRevision));
        return typeof saved === 'number' ? saved : undefined;
    } catch (error) {
        if (error instanceof PlayerRevisionConflictError) {
            console.warn(`Dropped a stale save for ${token}: `
                + `${error.message}`);
            return error.actual;
        }
        throw error;
    }
}

function queueFlightSave(store: PlayerStorePort, record: PlayerStatePersistenceRecord,
    state: PersistentPlayerState): Promise<void> {
    record.queued = state;
    if (record.pending) return record.pending;
    const drain = async () => {
        while (record.queued && !record.conflicted) {
            const next = record.queued;
            record.queued = undefined;
            try {
                const revision = await store.saveFlightState!(record.token, next, record.revision);
                if (typeof revision === 'number') {
                    record.revision = revision;
                    record.onRevision?.(revision);
                }
            } catch (error) {
                if (!(error instanceof PlayerRevisionConflictError)) throw error;
                // Only combat revisions are rebased by the store. Do not adopt
                // another session's whole-state revision and overwrite it later.
                record.conflicted = true;
                console.warn(`Dropped stale flight session for ${record.token}: ${error.message}`);
            }
        }
    };
    record.pending = drain().finally(() => { record.pending = undefined; });
    return record.pending;
}

export const PlayerStateSnapshots = new Resource<
    Map<string, PlayerStatePersistenceRecord>
>(
    'PlayerStateSnapshots');

export const ManageClientsSystem = new System({
    name: 'ManageClients',
    events: [RemovedPeerEvent],
    args: [RemovedPeerEvent, PlayerEntitiesQuery, Entities, SingletonComponent,
        PlayerStoreResource, SystemIdResource, PlayerStateSnapshots] as const,
    step: (removedPeer, multiplayerEntities, entities, _singleton,
        playerStore, systemId, snapshots) => {
        // Remove entities of peers who have disconnected
        for (const [multiplayerData, uuid, state, authority, entity] of multiplayerEntities) {
            if (multiplayerData.owner === removedPeer) {
                authority?.capture(entity);
                const token = playerStore.getTokenForPeer(removedPeer);
                if (token && state && (!playerStore.saveCombatResources || authority && !authority.retired)) {
                    // PlayerStore copies the state before retaining it.
                    const persistedState = toPersistentPlayerState(state);
                    if (!persistedState.currentSystem) {
                        persistedState.currentSystem = systemId;
                    }
                    const record = snapshots.get(uuid);
                    // The success and conflict paths both flush from the same
                    // promise callback, so a disconnect still reaches disk in
                    // the same turn it used to.
                    const expected = record?.token === token ? record.revision : authority?.storeRevision;
                    const flightRecord = flightRecordFor(token, authority, record);
                    void (playerStore.saveFlightState
                        ? queueFlightSave(playerStore, flightRecord, persistedState)
                        : playerStore.save(token, persistedState, undefined, expected))
                        .then(
                            () => playerStore.flush(),
                            error => {
                                if (error instanceof
                                    PlayerRevisionConflictError) {
                                    console.warn(
                                        `Dropped a stale disconnect save for `
                                        + `${token}: ${error.message}`);
                                    return playerStore.flush();
                                }
                                throw error;
                            })
                        .catch(error => console.error(
                            'Failed to flush player state on disconnect', error));
                } else if (token) {
                    void playerStore.flush().catch(error => console.error(
                        'Failed to flush player state on disconnect', error));
                }
                snapshots.delete(uuid);
                entities.delete(uuid);
            }
        }
    }
});

const LeaveSubscription = new Resource<Subscription>('LeaveSubscription');
const CombatInitializing = new Component<boolean>('CombatInitializing');
replicationPolicies.register(CombatInitializing, { codec: t.boolean, authority: 'local-only' });

export const InitializeCombatResourcesSystem = new System({
    name: 'InitializeCombatResources',
    args: [PlayerStateComponent, MultiplayerData, GetEntity, UUID, GetWorld,
        PlayerStoreResource, GameDataResource] as const,
    before: [MultiplayerPhase, ServerEnergyTransferSystem],
    step: (_state, multiplayerData, entity, uuid, world, store, gameData) => {
        if (multiplayerData.owner === 'server') return;
        const authority = entity.components.get(CombatAuthorityComponent);
        if (authority) { authority.capture(entity); return; }
        const token = store.getTokenForPeer(multiplayerData.owner);
        if (!token || entity.components.has(CombatInitializing)) return;
        entity.components.set(CombatInitializing, true);
        const arrivalState = toPersistentPlayerState(_state) as PlayerState;
        const owner = multiplayerData.owner;
        const applyAuthority = (auth: CombatAuthority, target: Entity) => {
            if (auth.retired) return;
            bindCombatOwner(owner, auth);
            // Room handoffs can carry an unsent final jump debit. Consume that
            // against a server-issued basis, never against a proposed balance.
            const debit = auth.acceptOwnerFuel(arrivalState);
            if (debit > 0) {
                auth.balance.fuel = Math.max(0, auth.balance.fuel - debit);
                auth.commit();
            }
            const hull = gameData.data.Ship.getCached?.(auth.balance.shipId);
            if (hull && target.components.get(ShipComponent)?.id !== hull.id) {
                target.components.set(ShipComponent, { id: hull.id });
                target.components.set(OutfitsStateComponent, new Map(
                    Object.entries(hull.outfits).map(([id, count]) => [id, { count }])));
            }
            target.components.set(CombatAuthorityComponent, auth);
            auth.project(target);
            auth.capture(target);
        };
        const syncAuth = combatLedger(store, gameData).getSync(token);
        if (syncAuth) {
            applyAuthority(syncAuth, entity);
            return;
        }
        void combatLedger(store, gameData).get(token).then(async authority => {
            if (authority.retired) return;
            const hull = await gameData.data.Ship.get(authority.balance.shipId);
            const current = world.entities.get(uuid);
            if (!current || current.components.get(MultiplayerData)?.owner !== owner
                || current.components.has(CombatAuthorityComponent)) return;
            const state = current.components.get(PlayerStateComponent);
            if (!state) return;
            bindCombatOwner(owner, authority);
            // Room handoffs can carry an unsent final jump debit. Consume that
            // against a server-issued basis, never against a proposed balance.
            const debit = authority.acceptOwnerFuel(arrivalState);
            if (debit > 0) {
                authority.balance.fuel = Math.max(0, authority.balance.fuel - debit);
                authority.commit();
            }
            if (current.components.get(ShipComponent)?.id !== hull.id) {
                current.components.set(ShipComponent, { id: hull.id });
                current.components.set(OutfitsStateComponent, new Map(
                    Object.entries(hull.outfits).map(([id, count]) => [id, { count }])));
            }
            current.components.set(CombatAuthorityComponent, authority);
            authority.project(current);
            authority.capture(current);
        }).catch(error => console.error('Combat initialization failed; firing remains disabled', error));
    },
});

export const PersistPlayerStateSystem = new System({
    name: 'PersistPlayerState',
    args: [
        PlayerPersistenceEntitiesQuery,
        PlayerStoreResource,
        PlayerStateSnapshots,
        DeltaResource,
        SingletonComponent,
    ] as const,
    // Multiplayer consumes DeltaMaker's dirty bit while creating outbound
    // deltas. Inspect persistence before that phase so a player mutation is
    // observed without stealing the delta from replication.
    before: [MultiplayerPhase],
    after: [InitializeCombatResourcesSystem, ServerEnergyTransferSystem],
    step: (players, playerStore, snapshots, deltaMaker, _singleton) => {
        for (const [multiplayerData, uuid, entity, state] of players) {
            const token = playerStore.getTokenForPeer(multiplayerData.owner);
            if (!token || playerStore.saveCombatResources
                && !entity.components.has(CombatAuthorityComponent)) {
                continue;
            }

            const authority = entity.components.get(CombatAuthorityComponent);
            if (authority?.retired) continue;
            authority?.capture(entity);
            const previous = snapshots.get(uuid);
            if (previous?.token === token
                && !deltaMaker.isComponentDirty(
                    entity, PlayerStateComponent as any)) {
                continue;
            }

            // Copy before yielding: multiplayer may replace this Immer draft
            // before PlayerStore.save reaches its first await.
            const persistedState = toPersistentPlayerState(state);
            const expected = previous?.token === token
                ? previous.revision : authority?.storeRevision;
            if (playerStore.saveFlightState) {
                const record = flightRecordFor(token, authority, previous);
                snapshots.set(uuid, record);
                void queueFlightSave(playerStore, record, persistedState).catch(error =>
                    console.error('Failed to save player state', error));
                continue;
            }
            snapshots.set(uuid, { token, revision: previous?.revision });
            void saveConditionally(
                playerStore, token, persistedState, expected)
                .then(revision => {
                    const current = snapshots.get(uuid);
                    if (current?.token === token) {
                        snapshots.set(uuid, { token, revision });
                    }
                })
                .catch(error =>
                    console.error('Failed to save player state', error));
        }
    },
});

const ServerSystemPlugin: Plugin = {
    name: 'ServerSystemPlugin',
    build(world) {
        const communicator = world.resources.get(CommunicatorResource);
        if (!communicator) {
            throw new Error('Expected CommunicatorResource to exist');
        }
        world.resources.set(PlayerStateSnapshots, new Map());
        world.addComponent(CombatAuthorityComponent);
        world.addComponent(CombatInitializing);
        world.addSystem(InitializeCombatResourcesSystem);
        // Cloak currently drains in both worlds. Its browser debit now arrives
        // as a deduplicated fuel intent; running the legacy server drain too
        // would charge twice. Jump/cloak intent validation remains legacy.
        world.removeSystem(CloakEnergyDrainSystem);
        world.addSystem(ManageClientsSystem);
        world.addSystem(PersistPlayerStateSystem);
        const subscription = communicator.peers.leave.subscribe(peer => {
            console.log(`${peer} left`);
            world.emit(RemovedPeerEvent, peer);
        });
        world.resources.set(LeaveSubscription, subscription);
    },
    remove(world) {
        world.resources.get(LeaveSubscription)?.unsubscribe();
    }
}

export const ServerPlugin: Plugin = {
    name: 'Server',
    async build(world) {
        const communicator = world.resources.get(CommunicatorResource);
        if (!communicator) {
            throw new Error('CommunicatorResource must exist');
        }
        const gameData = world.resources.get(GameDataResource);
        if (!gameData) {
            throw new Error('GameDataResource must exist');
        }
        const multiRoom = world.resources.get(MultiRoomResource);
        if (!multiRoom) {
            throw new Error('MultiRoomResource must exist');
        }
        const playerStore = world.resources.get(PlayerStoreResource) as
            PlayerStorePort | undefined;
        if (!playerStore) {
            throw new Error('PlayerStoreResource must exist');
        }
        await playerStore.ready;
        await combatLedger(playerStore, gameData).ready;
        const compatibilityProfile = world.resources.get(
            CompatibilityProfileResource) as CompatibilityProfile | undefined;

        const serverCommunicator = communicator as CommunicatorServer;
        communicator.peers.join.subscribe(peer => {
            const token = serverCommunicator.getPlayerToken(peer)
                ?? `legacy:${peer}`;
            playerStore.bindPeer(peer, token);
            void Promise.all([
                playerStore.get(token),
                playerStore.getSnapshots(token),
                playerStore.quarantine?.(token)
                    ?? Promise.resolve('none' as const),
            ]).then(([state, snapshots, quarantine]) => {
                const data = state
                    ? makePlayerData(peer, {
                        state,
                        savedAt: state.savedAt,
                        ship: state.ship,
                        snapshots,
                        quarantine,
                    })
                    : quarantine !== 'none'
                        ? makePlayerData(peer, { quarantine })
                        : {
                            uuid: peer,
                            snapshots: summarizeSnapshots(snapshots),
                        };
                communicator.sendMessage(PlayerData.encode(data), peer);
            });
        });

        for (const systemId of (await gameData.ids).System) {
            const systemRoom = multiRoom.join(systemId);
            systemRoom.peers.current.subscribe(async peers => {
                // Delete systems that have no (non-server) peers.
                const empty = [...peers].every(v => systemRoom.servers.value.has(v));
                if (empty) {
                    let cleanupPromise: Promise<void> | undefined;
                    if (world.entities.has(systemId)) {
                        console.log(`Deleting empty system ${systemId}`);
                        cleanupPromise = world.entities.get(systemId)!
                            .components.get(SystemComponent)?.removeAllPlugins();
                    }
                    world.entities.delete(systemId);
                    await cleanupPromise;
                } else {
                    // Create the system if it doesn't exist yet.
                    if (!world.entities.has(systemId)) {
                        const system = makeSystem(
                            systemId,
                            gameData,
                            playerStore,
                            compatibilityProfile ?? 'modern',
                        );
                        world.entities.set(systemId, new Entity()
                            .addComponent(SystemComponent, system));

                        console.log(`Created system ${systemId}`);
                        await system.addPlugin(multiplayer(systemRoom,
                            message => `System ${systemId}: ${message}`));
                        await system.addPlugin(ServerSystemPlugin);
                    }
                }
            });
        }
    }
}
