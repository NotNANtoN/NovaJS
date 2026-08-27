import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    MAX_PLAYER_SNAPSHOTS,
    PlayerDataFileQuarantinedError,
    PlayerRecordQuarantinedError,
    PlayerRevisionConflictError,
    PlayerStore,
} from './player_store';
import type { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';
import {
    PersistentPlayerStateCodec,
} from '../nova_plugin/player_state';
import type { PersistentPlayerState } from '../nova_plugin/player_state';
import {
    CURRENT_PLAYER_RECORD_SCHEMA_VERSION,
} from '../nova_plugin/player_state_migrations';

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

    it('advances the revision when a snapshot is restored', async () => {
        const store = await freshStore();
        await store.save('token', stateFor(1));
        const beforeRestore = await store.save('token', stateFor(2));
        const snapshot = await store.snapshot(
            'token', stateFor(2), undefined, 'manual');

        const restored = await store.restoreSnapshot('token', snapshot.id);
        expect(restored).toBeDefined();
        expect(await store.revision('token'))
            .toBeGreaterThan(beforeRestore);
        // A session that still holds the pre-restore revision must not be
        // able to write the restore away.
        await expectAsync(
            store.save('token', stateFor(99), undefined, beforeRestore))
            .toBeRejectedWithError(PlayerRevisionConflictError);
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

describe('player data safety', () => {
    async function temporaryFile(prefix: string) {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), prefix));
        return {
            directory,
            filePath: path.join(directory, 'players.json'),
        };
    }

    /**
     * The records already deployed carry every current field but no version,
     * so this is the upgrade every live pilot actually goes through.
     */
    it('upgrades an unversioned record in place without losing it',
        async () => {
            const { directory, filePath } = await temporaryFile(
                'novajs-player-store-unversioned-');
            const ship: EncodedEntity = {
                components: [
                    ['Ship', { id: 'nova:200' }],
                    ['OutfitsStateComponent', [['nova:150', { count: 2 }]]],
                ],
            };
            await fs.writeFile(filePath, JSON.stringify({
                pilot: {
                    ...stateFor(77),
                    credits: 8_642,
                    fuel: 250,
                    kills: 12,
                    holds: [
                        { commodity: 'nova:1', tons: 4, isMissionCargo: false },
                    ],
                    savedAt: 1_700_000_000_000,
                    revision: 9,
                    ship,
                    snapshots: [],
                },
            }));

            const store = new PlayerStore(filePath);
            await store.ready;

            const loaded = await store.get('pilot');
            expect(loaded).toBeDefined();
            expect(loaded?.credits).toBe(8_642);
            expect(loaded?.gameDate).toBe(77);
            expect(loaded?.fuel).toBe(250);
            expect(loaded?.kills).toBe(12);
            expect(loaded?.holds).toEqual([
                { commodity: 'nova:1', tons: 4, isMissionCargo: false },
            ]);
            // The stored ship carries the outfits, so it must survive.
            expect(loaded?.ship).toEqual(ship);
            expect(await store.revision('pilot')).toBe(9);

            await store.save('pilot', stateFor(78));
            await store.flush();
            const written = JSON.parse(
                await fs.readFile(filePath, 'utf8')) as Record<string, {
                    schemaVersion?: number,
                    credits?: number,
                    ship?: EncodedEntity,
                }>;
            expect(written.pilot.schemaVersion)
                .toBe(CURRENT_PLAYER_RECORD_SCHEMA_VERSION);
            expect(written.pilot.ship).toEqual(ship);
            await fs.rm(directory, { recursive: true, force: true });
        });

    it('reports why a pilot is being withheld', async () => {
        const record = await temporaryFile('novajs-player-store-why-record-');
        await fs.writeFile(record.filePath, JSON.stringify({
            pilot: { credits: 'not-a-number' },
        }));
        spyOn(console, 'warn');
        const recordStore = new PlayerStore(record.filePath);
        expect(await recordStore.quarantine('pilot')).toBe('record');
        expect(await recordStore.quarantine('other')).toBe('none');

        const file = await temporaryFile('novajs-player-store-why-file-');
        await fs.writeFile(file.filePath, '{"pilot":');
        spyOn(console, 'error');
        const fileStore = new PlayerStore(file.filePath);
        expect(await fileStore.quarantine('anyone')).toBe('file');

        await fs.rm(record.directory, { recursive: true, force: true });
        await fs.rm(file.directory, { recursive: true, force: true });
    });

    it('keeps malformed whole-file JSON untouched', async () => {
        const { directory, filePath } = await temporaryFile(
            'novajs-player-store-malformed-file-');
        const malformed = '{"pilot":';
        await fs.writeFile(filePath, malformed);
        spyOn(console, 'error');

        const store = new PlayerStore(filePath);
        await store.ready;

        expect(await store.get('pilot')).toBeUndefined();
        await expectAsync(store.getOrCreate('pilot'))
            .toBeRejectedWithError(PlayerDataFileQuarantinedError);
        expect(await fs.readFile(filePath, 'utf8')).toBe(malformed);
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('does not serve a malformed individual record', async () => {
        const { directory, filePath } = await temporaryFile(
            'novajs-player-store-malformed-record-');
        await fs.writeFile(filePath, JSON.stringify({
            pilot: {
                credits: 'not-a-number',
            },
        }));
        spyOn(console, 'warn');

        const store = new PlayerStore(filePath);
        await store.ready;

        expect(await store.get('pilot')).toBeUndefined();
        await expectAsync(store.getOrCreate('pilot'))
            .toBeRejectedWithError(PlayerRecordQuarantinedError);
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('drops only a malformed snapshot from a valid record', async () => {
        const { directory, filePath } = await temporaryFile(
            'novajs-player-store-malformed-snapshot-');
        await fs.writeFile(filePath, JSON.stringify({
            pilot: {
                ...stateFor(42),
                snapshots: [
                    {
                        id: 'broken',
                        createdAt: 1,
                        reason: 'landing',
                        state: {
                            credits: 'not-a-number',
                        },
                    },
                ],
            },
        }));
        spyOn(console, 'warn');

        const store = new PlayerStore(filePath);
        await store.ready;

        expect((await store.get('pilot'))?.gameDate).toBe(42);
        expect(await store.getSnapshots('pilot')).toEqual([]);
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('preserves a quarantined record during a later save', async () => {
        const { directory, filePath } = await temporaryFile(
            'novajs-player-store-quarantine-');
        const quarantined = {
            credits: 'undecodable',
            opaqueRecoveryData: {
                keep: ['every', 'value'],
            },
        };
        await fs.writeFile(filePath, JSON.stringify({
            damagedPilot: quarantined,
        }));
        spyOn(console, 'warn');
        const store = new PlayerStore(filePath);
        await store.ready;

        await store.save('healthyPilot', stateFor(9));
        await store.flush();

        const persisted = JSON.parse(
            await fs.readFile(filePath, 'utf8'),
        ) as Record<string, unknown>;
        expect(persisted.damagedPilot).toEqual(quarantined);
        expect(persisted.healthyPilot).toEqual(jasmine.objectContaining({
            schemaVersion: CURRENT_PLAYER_RECORD_SCHEMA_VERSION,
            gameDate: 9,
        }));
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('quarantines a future schema without overwriting it', async () => {
        const { directory, filePath } = await temporaryFile(
            'novajs-player-store-future-');
        const future = {
            ...stateFor(88),
            schemaVersion: CURRENT_PLAYER_RECORD_SCHEMA_VERSION + 1,
            snapshots: [],
            futureOnlyField: {
                mustSurvive: true,
            },
        };
        await fs.writeFile(filePath, JSON.stringify({
            futurePilot: future,
        }));
        spyOn(console, 'error');
        const store = new PlayerStore(filePath);
        await store.ready;

        expect(await store.get('futurePilot')).toBeUndefined();
        await expectAsync(store.save('futurePilot', stateFor(1)))
            .toBeRejectedWithError(PlayerRecordQuarantinedError);
        await store.save('healthyPilot', stateFor(2));
        await store.flush();

        const persisted = JSON.parse(
            await fs.readFile(filePath, 'utf8'),
        ) as Record<string, unknown>;
        expect(persisted.futurePilot).toEqual(future);
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('recovers the write chain after a failed atomic rename', async () => {
        const { directory, filePath } = await temporaryFile(
            'novajs-player-store-retry-');
        const store = new PlayerStore(filePath);
        await store.ready;
        const rename = spyOn(fs, 'rename').and.rejectWith(
            new Error('simulated rename failure'));

        await store.save('pilot', stateFor(1));
        await expectAsync(store.flush()).toBeRejectedWithError(
            'simulated rename failure');
        rename.and.callThrough();
        await store.save('pilot', stateFor(2));
        await store.flush();

        const reloaded = new PlayerStore(filePath);
        expect((await reloaded.get('pilot'))?.gameDate).toBe(2);
        const temporaryFiles = (await fs.readdir(directory))
            .filter(name => name.endsWith('.tmp'));
        expect(temporaryFiles).toEqual([]);
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('flushes a save made while an earlier write is active', async () => {
        const { directory, filePath } = await temporaryFile(
            'novajs-player-store-drain-');
        const store = new PlayerStore(filePath);
        await store.ready;
        const actualRename = fs.rename.bind(fs);
        let releaseRename: () => void = () => undefined;
        let markRenameStarted: () => void = () => undefined;
        const renameStarted = new Promise<void>(resolve => {
            markRenameStarted = resolve;
        });
        const allowRename = new Promise<void>(resolve => {
            releaseRename = resolve;
        });
        let delayNextRename = true;
        spyOn(fs, 'rename').and.callFake(async (from, to) => {
            if (delayNextRename) {
                delayNextRename = false;
                markRenameStarted();
                await allowRename;
            }
            await actualRename(from, to);
        });

        await store.save('pilot', stateFor(1));
        const flushing = store.flush();
        await renameStarted;
        await store.save('pilot', stateFor(2));
        releaseRename();
        await flushing;

        const reloaded = new PlayerStore(filePath);
        expect((await reloaded.get('pilot'))?.gameDate).toBe(2);
        await fs.rm(directory, { recursive: true, force: true });
    });
});
