import * as t from 'io-ts';
import { Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Entity } from "nova_ecs/entity";
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from "nova_ecs/plugin";
import {
    CommunicatorResource,
    multiplayer,
    MultiplayerData,
    MultiplayerPhase,
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
    PlayerData as PlayerDataCodec,
    PlayerRevisionConflictError,
    PlayerStateCodec,
    PlayerStateComponent,
    PlayerStorePort,
    PlayerStoreResource,
    toPersistentPlayerState,
} from './player_state';

import { SystemIdResource } from './system_id_resource';

// Kept exported here for compatibility with code that used the original
// server-plugin stub. The codec itself is browser-safe and lives with state.
export const PlayerData = PlayerDataCodec;
export type PlayerData = t.TypeOf<typeof PlayerDataCodec>;

export const RemovedPeerEvent = new EcsEvent<string>('RemovedPeerEvent');
const PlayerEntitiesQuery = new Query([
    MultiplayerData, UUID, Optional(PlayerStateComponent),
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
        const saved = await playerStore.save(
            token, state, undefined, expectedRevision);
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
        for (const [multiplayerData, uuid, state] of multiplayerEntities) {
            if (multiplayerData.owner === removedPeer) {
                const token = playerStore.getTokenForPeer(removedPeer);
                if (token && state) {
                    // PlayerStore copies the state before retaining it.
                    const persistedState = toPersistentPlayerState(state);
                    if (!persistedState.currentSystem) {
                        persistedState.currentSystem = systemId;
                    }
                    const record = snapshots.get(uuid);
                    // The success and conflict paths both flush from the same
                    // promise callback, so a disconnect still reaches disk in
                    // the same turn it used to.
                    void playerStore.save(
                        token, persistedState, undefined,
                        record?.token === token ? record.revision : undefined)
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
    step: (players, playerStore, snapshots, deltaMaker, _singleton) => {
        for (const [multiplayerData, uuid, entity, state] of players) {
            const token = playerStore.getTokenForPeer(multiplayerData.owner);
            if (!token) {
                continue;
            }

            const previous = snapshots.get(uuid);
            if (previous?.token === token
                && !deltaMaker.isComponentDirty(
                    entity, PlayerStateComponent)) {
                continue;
            }

            // Copy before yielding: multiplayer may replace this Immer draft
            // before PlayerStore.save reaches its first await.
            const persistedState = toPersistentPlayerState(state);
            const expected = previous?.token === token
                ? previous.revision : undefined;
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
            ]).then(([state, snapshots]) => {
                const data: PlayerData = {
                    uuid: peer,
                    snapshots: snapshots.map(({
                        id, createdAt, reason, state: snapshotState,
                    }) => ({
                        id,
                        createdAt,
                        reason,
                        pilotName: snapshotState.pilotName,
                        currentSystem: snapshotState.currentSystem,
                    })),
                };
                if (state) {
                    const decodedState = PlayerStateCodec.decode(state);
                    if (decodedState._tag === 'Left') {
                        throw new Error(
                            `Invalid persisted player state for ${token}`,
                        );
                    }
                    data.system = state.currentSystem;
                    data.savedAt = state.savedAt;
                    data.playerState = decodedState.right;
                }
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
