import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    MAX_PLAYER_SNAPSHOTS,
    PlayerRevisionConflictError,
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

    it('clears the death marker when restoring a snapshot', async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), 'novajs-player-store-death-'));
        const store = new PlayerStore(path.join(directory, 'players.json'));
        const state = stateFor(1);
        const snapshot = await store.snapshot('pilot', state);
        await store.save('pilot', {
            ...state,
            diedAt: 12_345,
        });

        const restored = await store.restoreSnapshot('pilot', snapshot.id);

        expect(restored?.diedAt).toBeUndefined();
        expect((await store.get('pilot'))?.diedAt).toBeUndefined();
        await fs.rm(directory, { recursive: true, force: true });
    });
});

describe('player state revisions', () => {
    async function freshStore() {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), 'novajs-player-store-revision-'));
        return new PlayerStore(path.join(directory, 'players.json'));
    }

    it('starts at revision zero and counts every accepted write', async () => {
        const store = await freshStore();
        expect(await store.revision('token')).toBe(0);
        expect(await store.save('token', stateFor(1))).toBe(1);
        expect(await store.save('token', stateFor(2))).toBe(2);
        expect(await store.revision('token')).toBe(2);
    });

    it('accepts a conditional save that presents the current revision',
        async () => {
            const store = await freshStore();
            const first = await store.save('token', stateFor(1));
            expect(await store.save('token', stateFor(2), undefined, first))
                .toBe(2);
            expect((await store.get('token'))?.gameDate).toBe(2);
        });

    it('rejects a save from a session that has fallen behind', async () => {
        const store = await freshStore();
        const stale = await store.save('token', stateFor(1));
        // Another session saves in the meantime.
        await store.save('token', stateFor(2));

        await expectAsync(store.save('token', stateFor(99), undefined, stale))
            .toBeRejectedWithError(PlayerRevisionConflictError);
        // The newer progress survives rather than being overwritten.
        expect((await store.get('token'))?.gameDate).toBe(2);
    });

    it('reports the revision it is actually at when rejecting', async () => {
        const store = await freshStore();
        await store.save('token', stateFor(1));
        await store.save('token', stateFor(2));
        try {
            await store.save('token', stateFor(3), undefined, 1);
            throw new Error('Expected a revision conflict');
        } catch (error) {
            const conflict = error as PlayerRevisionConflictError;
            expect(conflict.expected).toBe(1);
            expect(conflict.actual).toBe(2);
        }
    });

    it('keeps revisions across a reload so a restart cannot lose them',
        async () => {
            const directory = await fs.mkdtemp(
                path.join(os.tmpdir(), 'novajs-player-store-reload-'));
            const filePath = path.join(directory, 'players.json');
            const store = new PlayerStore(filePath);
            await store.save('token', stateFor(1));
            await store.save('token', stateFor(2));
            await store.flush();

            const reloaded = new PlayerStore(filePath);
            expect(await reloaded.revision('token')).toBe(2);
            await expectAsync(
                reloaded.save('token', stateFor(3), undefined, 1))
                .toBeRejectedWithError(PlayerRevisionConflictError);
        });
});
