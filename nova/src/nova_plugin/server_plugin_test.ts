import * as t from 'io-ts';
import 'jasmine';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlayerStore } from '../server/player_store';
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
    InitializeCombatResourcesSystem,
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
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { CombatAuthorityComponent, consumeShot } from './combat_resources';
import { OutfitsStateComponent } from './outfit_plugin';
import { ShipComponent } from './ship_plugin';
import { ArmorComponent, ShieldComponent } from './health_plugin';
import { Stat } from './stat';

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

describe('combat resource bootstrap', () => {
    it('queues real-store flight progress across repeated shot revisions and disconnect', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'novajs-flight-persistence-'));
        const store = new PlayerStore(join(directory, 'players.json'));
        try {
            await store.ready;
            await store.save('pilot', { ...createInitialPlayerState(), fuel: 120 });
            store.bindPeer('peer', 'pilot');
            const { world } = setup(true);
            const data = new MockGameData();
            data.data.Ship.map.set('nova:128', { ...getDefaultShipData(), id: 'nova:128', fuelCapacity: 300 });
            world.resources.set(PlayerStoreResource, store);
            world.resources.set(GameDataResource, data);
            world.addSystem(InitializeCombatResourcesSystem);
            world.step();
            for (let i = 0; i < 30; i++) await Promise.resolve();
            const entity = world.entities.get('player')!;
            for (let frame = 1; frame <= 5; frame++) {
                entity.components.get(PlayerStateComponent)!.missionBits[frame] = true;
                expect(consumeShot(entity, ['energy', 1])).toBeTrue();
                entity.components.get(PlayerStateComponent)!.gameDate = frame;
                world.step();
            }
            entity.components.get(PlayerStateComponent)!.holds = [
                { commodity: 'Food', tons: 2, isMissionCargo: false },
            ];
            const pending = world.resources.get(PlayerStateSnapshots)!.get('player')?.pending;
            world.emit(RemovedPeerEvent, 'peer');
            world.step();
            await pending;
            const saved = (await store.get('pilot'))!;
            expect(saved.fuel).toBe(115);
            expect(saved.gameDate).toBe(5);
            expect(saved.missionBits.slice(1, 6)).toEqual([true, true, true, true, true]);
            expect(saved.holds[0].tons).toBe(2);
            expect(world.entities.has('player')).toBeFalse();
        } finally { await store.flush(); await rm(directory, { recursive: true, force: true }); }
    });
    it('ignores client initial balances and reuses debited balances after entity replacement', async () => {
        const { world, entity, store } = setup();
        const data = new MockGameData();
        data.data.Ship.map.set('nova:128', { ...getDefaultShipData(), id: 'nova:128', fuelCapacity: 300, outfits: { ammo: 4 } });
        data.data.Weapon.map.set('weapon', { ...getDefaultProjectileWeaponData(), id: 'weapon', ammoType: ['outfit', 'ammo'] });
        Object.assign(store, {
            get: async () => ({ ...createInitialPlayerState(), fuel: 120 }),
            saveCombatResources: jasmine.createSpy('saveCombatResources'),
        });
        world.resources.set(GameDataResource, data);
        world.addSystem(InitializeCombatResourcesSystem);
        entity.components.set(OutfitsStateComponent, new Map([['ammo', { count: 999 }]]));
        entity.components.set(ShipComponent, { id: 'forged' });
        entity.components.get(PlayerStateComponent)!.fuel = 99999;
        expect(consumeShot(entity, ['energy', 1])).toBeFalse();
        world.step();
        expect(store.saves.length).toBe(0);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        const first = world.entities.get('player')!;
        expect(first.components.has(CombatAuthorityComponent)).toBeTrue();
        expect(first.components.get(PlayerStateComponent)!.fuel).toBe(120);
        expect(first.components.get(OutfitsStateComponent)!.get('ammo')?.count).toBe(4);
        expect(consumeShot(first, ['energy', 20])).toBeTrue();
        expect(consumeShot(first, ['outfit', 'ammo'])).toBeTrue();
        world.entities.delete('player');
        const replacement = new Entity().addComponent(MultiplayerData, { owner: 'peer' })
            .addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(OutfitsStateComponent, new Map([['ammo', { count: 999 }]]));
        world.entities.set('replacement', replacement);
        world.step();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(replacement.components.get(PlayerStateComponent)!.fuel).toBe(100);
        expect(replacement.components.get(OutfitsStateComponent)!.get('ammo')?.count).toBe(3);
        world.step();
        const saves = store.saves.length;
        for (let i = 0; i < 3; i++) world.step();
        expect(store.saves.length).toBe(saves);
    });

    it('preserves spent jump fuel and damaged health across room transitions', async () => {
        const { world, entity, store } = setup();
        const data = new MockGameData();
        data.data.Ship.map.set('nova:128', { ...getDefaultShipData(), id: 'nova:128', fuelCapacity: 300, shield: 200, armor: 150 });
        Object.assign(store, {
            get: async () => ({ ...createInitialPlayerState(), fuel: 300 }),
            saveCombatResources: jasmine.createSpy('saveCombatResources'),
        });
        world.resources.set(GameDataResource, data);
        world.addSystem(InitializeCombatResourcesSystem);
        world.step();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        const first = world.entities.get('player')!;
        expect(first.components.get(PlayerStateComponent)!.fuel).toBe(300);

        first.components.set(ShieldComponent, new Stat({ current: 80, max: 200 }));
        first.components.set(ArmorComponent, new Stat({ current: 50, max: 150 }));
        const authority = first.components.get(CombatAuthorityComponent)!;
        authority.capture(first);
        expect(authority.armor).toBe(50);
        expect(authority.shield).toBe(80);

        world.entities.delete('player');
        const arrivalState = { ...createInitialPlayerState(), fuel: 200 };
        const arriving = new Entity()
            .addComponent(MultiplayerData, { owner: 'peer' })
            .addComponent(PlayerStateComponent, arrivalState)
            .addComponent(ShieldComponent, new Stat({ current: 80, max: 200 }))
            .addComponent(ArmorComponent, new Stat({ current: 50, max: 150 }));
        world.entities.set('arriving', arriving);
        world.step();

        expect(arriving.components.get(PlayerStateComponent)!.fuel).toBe(200);
        expect(arriving.components.get(ArmorComponent)!.current).toBe(50);
        expect(arriving.components.get(ShieldComponent)!.current).toBe(80);
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
