import * as t from 'io-ts';
import { Entities, UUID } from 'nova_ecs/arg_types';
import { Entity } from "nova_ecs/entity";
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from "nova_ecs/plugin";
import { CommunicatorResource, multiplayer, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
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
    PlayerData as PlayerDataCodec,
    PlayerState,
    PlayerStateComponent,
    PlayerStoreResource,
} from './player_state';
import { SystemIdResource } from './system_id_resource';

// Kept exported here for compatibility with code that used the original
// server-plugin stub. The codec itself is browser-safe and lives with state.
export const PlayerData = PlayerDataCodec;
export type PlayerData = t.TypeOf<typeof PlayerDataCodec>;

type PersistedPlayerState = Omit<PlayerState, 'freeSpace'>;

interface PlayerStoreApi {
    readonly ready: Promise<void>;
    getOrCreate(token: string): Promise<PersistedPlayerState>;
    save(token: string, state: PersistedPlayerState, ship?: unknown): Promise<void>;
    bindPeer(peerId: string, token: string): void;
    getTokenForPeer(peerId: string): string | undefined;
}

const RemovedPeerEvent = new EcsEvent<string>('RemovedPeerEvent');
const PlayerEntitiesQuery = new Query([
    MultiplayerData, UUID, Optional(PlayerStateComponent),
] as const);

export const ManageClientsSystem = new System({
    name: 'ManageClients',
    events: [RemovedPeerEvent],
    args: [RemovedPeerEvent, PlayerEntitiesQuery, Entities, SingletonComponent,
        PlayerStoreResource, SystemIdResource] as const,
    step: (removedPeer, multiplayerEntities, entities, _singleton,
        playerStore, systemId) => {
        // Remove entities of peers who have disconnected
        const store = playerStore as PlayerStoreApi;
        for (const [multiplayerData, uuid, state] of multiplayerEntities) {
            if (multiplayerData.owner === removedPeer) {
                const token = store.getTokenForPeer(removedPeer);
                if (token && state) {
                    // PlayerStore copies the state before retaining it.
                    void store.save(token, {
                        credits: state.credits,
                        missionBits: [...state.missionBits],
                        gameDate: state.gameDate,
                        activeMissions: state.activeMissions.map(mission => ({ ...mission })),
                        shipId: state.shipId,
                        currentSystem: state.currentSystem || systemId,
                        cargoCapacity: state.cargoCapacity,
                        holds: state.holds.map(hold => ({ ...hold })),
                    });
                }
                entities.delete(uuid);
            }
        }
    }
});

const LeaveSubscription = new Resource<Subscription>('LeaveSubscription');
const PlayerStateSnapshots = new Resource<Map<string, string>>(
    'PlayerStateSnapshots');

function playerStateFingerprint(state: PlayerState): string {
    let bitHash = 2166136261;
    for (const bit of state.missionBits) {
        bitHash ^= bit ? 1 : 0;
        bitHash = Math.imul(bitHash, 16777619);
    }
    return [
        state.credits,
        state.gameDate,
        state.shipId,
        state.currentSystem,
        bitHash,
        JSON.stringify(state.activeMissions),
        state.cargoCapacity,
        JSON.stringify(state.holds),
    ].join('|');
}

const PersistPlayerStateSystem = new System({
    name: 'PersistPlayerState',
    args: [PlayerEntitiesQuery, PlayerStoreResource, PlayerStateSnapshots] as const,
    step: (players, playerStore, snapshots) => {
        const store = playerStore as PlayerStoreApi;
        for (const [multiplayerData, uuid, state] of players) {
            if (!state) {
                continue;
            }
            const token = store.getTokenForPeer(multiplayerData.owner);
            if (!token) {
                continue;
            }
            const fingerprint = playerStateFingerprint(state);
            if (snapshots.get(uuid) === fingerprint) {
                continue;
            }
            snapshots.set(uuid, fingerprint);
            // Copy before yielding: multiplayer may replace this Immer draft
            // before PlayerStore.save reaches its first await.
            void store.save(token, {
                credits: state.credits,
                missionBits: [...state.missionBits],
                gameDate: state.gameDate,
                activeMissions: state.activeMissions.map(mission => ({ ...mission })),
                shipId: state.shipId,
                currentSystem: state.currentSystem,
                cargoCapacity: state.cargoCapacity,
                holds: state.holds.map(hold => ({ ...hold })),
            });
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
        world.addSystem(ManageClientsSystem);
        world.resources.set(PlayerStateSnapshots, new Map());
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
            PlayerStoreApi | undefined;
        if (!playerStore) {
            throw new Error('PlayerStoreResource must exist');
        }
        await playerStore.ready;

        const serverCommunicator = communicator as CommunicatorServer;
        communicator.peers.join.subscribe(peer => {
            const token = serverCommunicator.getPlayerToken(peer)
                ?? `legacy:${peer}`;
            playerStore.bindPeer(peer, token);
            void playerStore.getOrCreate(token).then(state => {
                const data: PlayerData = {
                    uuid: peer,
                    system: state.currentSystem,
                    playerState: state as PlayerState,
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
                        const system = makeSystem(systemId, gameData, playerStore);
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
