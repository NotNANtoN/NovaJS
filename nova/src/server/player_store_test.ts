import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    MAX_PLAYER_SNAPSHOTS,
    PlayerStore,
} from './player_store';
import type { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';
import {
    PersistentPlayerStateCodec,
} from '../nova_plugin/player_state';
import type { PersistentPlayerState } from '../nova_plugin/player_state';

function stateFor(gameDate: number): PersistentPlayerState {
    return {
        credits: 10_000,
        missionBits: [],
        gameDate,
        activeMissions: [],
        shipId: 'nova:128',
        currentSystem: 'nova:130',
        lastLandedPlanet: 'nova:128',
        lastLandedSystem: 'nova:130',
        lastLandedPosition: [0, 0],
        cargoCapacity: 10,
        holds: [],
        pilotName: 'Captain',
        shipName: 'Nova',
        gender: 'male',
        destroyedStellars: [],
        activeRanks: [],
        exploredSystems: ['nova:130'],
    };
}

describe('player snapshots', () => {
    it('round-trips encoded state and ship through a new store', async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), 'novajs-player-store-roundtrip-'));
        const filePath = path.join(directory, 'players.json');
        const state = stateFor(42);
        const encodedState = PersistentPlayerStateCodec.encode(state);
        const decodedState = PersistentPlayerStateCodec.decode(encodedState);
        if (decodedState._tag === 'Left') {
            throw new Error('Expected encoded player state to decode');
        }
        const ship = {
            name: 'player-ship',
            components: [['ShipComponent', { id: 'nova:128' }]],
        } as EncodedEntity;
        const store = new PlayerStore(filePath);
        await store.ready;
        const snapshot = await store.snapshot(
            'pilot', decodedState.right, ship);
        await store.flush();

        const reloaded = new PlayerStore(filePath);
        await reloaded.ready;
        const restored = await reloaded.restoreSnapshot('pilot', snapshot.id);

        expect(restored).toEqual(jasmine.objectContaining({
            ...decodedState.right,
            ship,
        }));
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('rotates snapshots and restores an older retained state', async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), 'novajs-player-store-'));
        const store = new PlayerStore(path.join(directory, 'players.json'));
        await store.ready;

        for (let gameDate = 0; gameDate < MAX_PLAYER_SNAPSHOTS + 2; gameDate++) {
            await store.snapshot('pilot', stateFor(gameDate));
        }

        const snapshots = await store.getSnapshots('pilot');
        expect(snapshots.length).toBe(MAX_PLAYER_SNAPSHOTS);
        expect(snapshots[0].createdAt).toBeDefined();

        const restored = await store.restoreSnapshot('pilot', snapshots[0].id);
        expect(restored?.gameDate).toBe(2);
        expect((await store.getSnapshots('pilot')).length)
            .toBe(MAX_PLAYER_SNAPSHOTS);

        await store.flush();
        const reloaded = new PlayerStore(path.join(directory, 'players.json'));
        await reloaded.ready;
        expect((await reloaded.getSnapshots('pilot')).length)
            .toBe(MAX_PLAYER_SNAPSHOTS);
        expect((await reloaded.restoreSnapshot('pilot', snapshots[0].id))
            ?.gameDate).toBe(2);
        await fs.rm(directory, { recursive: true, force: true });
    });
});
