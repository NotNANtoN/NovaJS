import * as t from 'io-ts';
import 'jasmine';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MockCommunicator } from 'nova_ecs/plugins/mock_communicator';
import { multiplayer, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';
import { MultiRoom } from '../communication/multi_room_communicator';
import {
    ManageClientsSystem,
    PersistPlayerStateSystem,
    PlayerData,
    PlayerStateSnapshots,
    RemovedPeerEvent,
    ServerPlugin,
} from './server_plugin';
import {
    createInitialPlayerState,
    PersistentPlayerState,
    PlayerStateComponent,
    PlayerStatePlugin,
    PlayerStoreResource,
} from './player_state';
import { GameDataResource } from './game_data_resource';
import { MultiRoomResource } from './nova_plugin';
import { SystemIdResource } from './system_id_resource';
import { MockGameData } from 'novadatainterface/MockGameData';

const NonPersistentComponent = new Component<{ value: number }>(
    'ServerPluginTestNonPersistent');
const NonPersistentCodec = t.type({ value: t.number });

interface RecordingStore {
    readonly ready: Promise<void>;
    readonly saves: Array<{
        token: string;
        state: PersistentPlayerState;
    }>;
    flushes: number;
    save(
        token: string,
        state: PersistentPlayerState,
    ): Promise<void>;
    flush(): Promise<void>;
    bindPeer(peer: string, token: string): void;
    getTokenForPeer(peer: string): string | undefined;
}

function recordingStore(): RecordingStore {
    const tokens = new Map<string, string>();
    const store: RecordingStore = {
        ready: Promise.resolve(),
        saves: [],
        flushes: 0,
        save(token, state) {
            this.saves.push({ token, state });
            return Promise.resolve();
        },
        flush() {
            this.flushes++;
            return Promise.resolve();
        },
        bindPeer(peer, token) {
            tokens.set(peer, token);
        },
        getTokenForPeer(peer) {
            return tokens.get(peer);
        },
    };
    return store;
}

function setup(includeLeaveSystem = false) {
    const store = recordingStore();
    const communicator = new MockCommunicator('server');
    const world = new World('server persistence test');
    world.addPlugin(multiplayer(communicator));
    world.resources.set(
        PlayerStoreResource,
        store as any,
    );
    world.resources.set(SystemIdResource, 'nova:130');
    world.resources.set(PlayerStateSnapshots, new Map());
    world.addPlugin(PlayerStatePlugin);

    world.addComponent(NonPersistentComponent);
    const deltaMaker = world.resources.get(DeltaResource)!;
    deltaMaker.addComponent(NonPersistentComponent, {
        componentType: NonPersistentCodec,
    });

    world.addSystem(PersistPlayerStateSystem);
    if (includeLeaveSystem) {
        world.addSystem(ManageClientsSystem);
    }

    const entity = new Entity()
        .addComponent(MultiplayerData, { owner: 'peer' })
        .addComponent(PlayerStateComponent, createInitialPlayerState())
        .addComponent(NonPersistentComponent, { value: 0 });
    world.entities.set('player', entity);
    store.bindPeer('peer', 'pilot');
    return { entity, store, world };
}

describe('server player persistence', () => {
    it('does no persistent work on unchanged frames', () => {
        const { store, world } = setup();

        world.step();
        expect(store.saves.length).toBe(1);

        for (let frame = 0; frame < 5; frame++) {
            world.step();
        }

        expect(store.saves.length).toBe(1);
    });

    it('coalesces burst mutations and saves the final state once', () => {
        const { entity, store, world } = setup();

        world.step();
        const state = entity.components.get(PlayerStateComponent)!;
        state.credits++;
        state.credits++;
        state.missionBits[7] = true;
        world.step();

        expect(store.saves.length).toBe(2);
        expect(store.saves[1].state.credits).toBe(10_002);
        expect(store.saves[1].state.missionBits[7]).toBeTrue();
    });

    it('ignores non-persistent entity changes', () => {
        const { entity, store, world } = setup();

        world.step();
        entity.components.get(NonPersistentComponent)!.value++;
        world.step();

        expect(store.saves.length).toBe(1);
    });

    it('flushes the latest mutation before removing a disconnected player', async () => {
        const { entity, store, world } = setup(true);

        world.step();
        entity.components.get(PlayerStateComponent)!.credits = 77_777;
        world.emit(RemovedPeerEvent, 'peer');
        world.step();
        await Promise.resolve();

        expect(store.saves.at(-1)?.state.credits).toBe(77_777);
        expect(store.flushes).toBe(1);
        expect(world.entities.has('player')).toBeFalse();
    });
});

describe('server player bootstrap', () => {
    it('sends the stored ship when a peer joins', async () => {
        const peers = new Map<string, MockCommunicator>();
        const server = new MockCommunicator('server', peers) as
            MockCommunicator & {
                getPlayerToken(peer: string): string | undefined;
            };
        server.getPlayerToken = () => 'pilot';
        const client = new MockCommunicator('client', peers);
        peers.set('server', server);
        peers.set('client', client);
        const state = createInitialPlayerState();
        const ship: EncodedEntity = {
            name: 'Shuttle',
            components: [['Ship', { id: state.shipId }]],
        };
        const store = {
            ready: Promise.resolve(),
            bindPeer: jasmine.createSpy('bindPeer'),
            getTokenForPeer: () => 'pilot',
            get: async () => ({
                ...state,
                savedAt: 123,
                ship,
            }),
            getSnapshots: async () => [],
        };
        const world = new World('server bootstrap test');
        world.resources.set(GameDataResource, new MockGameData());
        world.resources.set(MultiRoomResource, new MultiRoom(server));
        world.resources.set(PlayerStoreResource, store as any);
        await world.addPlugin(multiplayer(server));
        await world.addPlugin(ServerPlugin);

        server.peers.current.next(new Set(['client']));
        await new Promise(resolve => setTimeout(resolve, 0));

        const sent = client.allMessages
            .map(value => (value as { message?: unknown }).message)
            .map(value => PlayerData.decode(value))
            .find(decoded => decoded._tag === 'Right');
        expect(sent?._tag).toBe('Right');
        if (sent?._tag !== 'Right') {
            return;
        }
        expect(sent.right.ship).toEqual(ship);
        expect(sent.right.playerState?.shipId).toBe(state.shipId);
        expect(store.bindPeer).toHaveBeenCalledOnceWith('client', 'pilot');
    });

    it('reports a quarantined pilot when no state can be served', async () => {
        const peers = new Map<string, MockCommunicator>();
        const server = new MockCommunicator('server', peers) as
            MockCommunicator & {
                getPlayerToken(peer: string): string | undefined;
            };
        server.getPlayerToken = () => 'pilot';
        const client = new MockCommunicator('client', peers);
        peers.set('server', server);
        peers.set('client', client);
        const store = {
            ready: Promise.resolve(),
            bindPeer: jasmine.createSpy('bindPeer'),
            getTokenForPeer: () => 'pilot',
            get: async () => undefined,
            getSnapshots: async () => [],
            quarantine: async () => 'record' as const,
        };
        const world = new World('quarantined bootstrap test');
        world.resources.set(GameDataResource, new MockGameData());
        world.resources.set(MultiRoomResource, new MultiRoom(server));
        world.resources.set(PlayerStoreResource, store as any);
        await world.addPlugin(multiplayer(server));
        await world.addPlugin(ServerPlugin);

        server.peers.current.next(new Set(['client']));
        await new Promise(resolve => setTimeout(resolve, 0));

        const sent = client.allMessages
            .map(value => (value as { message?: unknown }).message)
            .map(value => PlayerData.decode(value))
            .find(decoded => decoded._tag === 'Right'
                && decoded.right.quarantine === 'record');
        expect(sent?._tag).toBe('Right');
        if (sent?._tag !== 'Right') {
            return;
        }
        expect(sent.right).toEqual({
            uuid: 'client',
            quarantine: 'record',
        });
    });
});
