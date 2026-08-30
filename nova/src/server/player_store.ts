import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as t from 'io-ts';
import {
    clonePlayerState,
    createInitialPlayerState,
    PersistentPlayerStateCodec,
    PlayerSnapshot,
    PlayerSnapshotCodec,
    toPersistentPlayerState,
} from '../nova_plugin/player_state';
import { PlayerRevisionConflictError } from '../nova_plugin/player_state';
import type {
    PersistentPlayerState,
    PlayerQuarantine,
    PlayerStorePort,
} from '../nova_plugin/player_state';
import {
    CURRENT_PLAYER_RECORD_SCHEMA_VERSION,
    migratePlayerRecord,
} from '../nova_plugin/player_state_migrations';

export { PlayerRevisionConflictError };
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';

const PLAYER_DATA_DIRECTORY = 'NovaJS-data';
const PLAYER_DATA_FILE = 'players.json';
export const MAX_PLAYER_SNAPSHOTS = 10;

export interface StoredPlayer extends PersistentPlayerState {
    schemaVersion: typeof CURRENT_PLAYER_RECORD_SCHEMA_VERSION;
    savedAt?: number;
    ship?: EncodedEntity;
    snapshots: PlayerSnapshot[];
    /**
     * Incremented on every accepted write. A writer that saw an older
     * revision is refusing to be the one that overwrites newer progress.
     */
    revision?: number;
}



const StoredPlayerCodec = t.intersection([
    PersistentPlayerStateCodec,
    t.type({
        schemaVersion: t.literal(CURRENT_PLAYER_RECORD_SCHEMA_VERSION),
        snapshots: t.array(PlayerSnapshotCodec),
    }),
    t.partial({
        savedAt: t.number,
        ship: EncodedEntity,
        revision: t.number,
    }),
]);

function defaultPlayerDataPath() {
    const configured = process.env.NOVA_PLAYER_DATA
        ?? path.join(os.homedir(), PLAYER_DATA_DIRECTORY, PLAYER_DATA_FILE);
    return configured.startsWith('~/')
        ? path.join(os.homedir(), configured.slice(2))
        : path.resolve(configured);
}

function initialPlayerState(): StoredPlayer {
    return {
        ...createInitialPlayerState(),
        schemaVersion: CURRENT_PLAYER_RECORD_SCHEMA_VERSION,
        snapshots: [],
    };
}

function cloneSnapshot(snapshot: PlayerSnapshot): PlayerSnapshot {
    return {
        ...snapshot,
        state: clonePlayerState(snapshot.state),
        ...(snapshot.ship === undefined
            ? {}
            : {
                ship: JSON.parse(JSON.stringify(snapshot.ship)) as EncodedEntity,
            }),
    };
}

function clonePlayer(player: StoredPlayer): StoredPlayer {
    return {
        ...player,
        ...clonePlayerState(player),
        ...(player.ship === undefined
            ? {}
            : { ship: JSON.parse(JSON.stringify(player.ship)) as EncodedEntity }),
        snapshots: player.snapshots.map(cloneSnapshot),
    };
}

function normalizePlayer(
    player: t.TypeOf<typeof StoredPlayerCodec>,
): StoredPlayer {
    const state = toPersistentPlayerState(player);
    return {
        ...state,
        schemaVersion: CURRENT_PLAYER_RECORD_SCHEMA_VERSION,
        ...(player.savedAt === undefined ? {} : { savedAt: player.savedAt }),
        ...(player.ship === undefined
            ? {}
            : { ship: JSON.parse(JSON.stringify(player.ship)) as EncodedEntity }),
        snapshots: (player.snapshots ?? []).map(cloneSnapshot),
        ...(player.revision === undefined
            ? {}
            : { revision: player.revision }),
    };
}

export class PlayerRecordQuarantinedError extends Error {
    constructor(readonly token: string) {
        super(`Player record '${token}' is quarantined`);
    }
}

export class PlayerDataFileQuarantinedError extends Error {
    constructor(readonly filePath: string) {
        super(`Player data file '${filePath}' is quarantined`);
    }
}

/**
 * Debounced JSON persistence for player state.
 *
 * The file is replaced with rename(2) after every debounce window. The
 * in-memory map is keyed by the client-provided persistent token; transport
 * peer IDs are tracked separately and are never written as player identity.
 */
export class PlayerStore implements PlayerStorePort {
    readonly filePath: string;
    readonly ready: Promise<void>;
    private players = new Map<string, StoredPlayer>();
    private quarantinedPlayers = new Map<string, unknown>();
    private peerTokens = new Map<string, string>();
    private saveTimer?: NodeJS.Timeout;
    private writePromise: Promise<void> = Promise.resolve();
    private dirty = false;
    private fileQuarantined = false;
    private snapshotSequence = 0;

    constructor(filePath = defaultPlayerDataPath()) {
        this.filePath = path.resolve(filePath);
        this.ready = this.load();
    }

    private async load() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        let serialized: string;
        try {
            serialized = await fs.readFile(this.filePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            await this.writeFile();
            return;
        }

        let raw: unknown;
        try {
            raw = JSON.parse(serialized) as unknown;
        } catch {
            this.fileQuarantined = true;
            console.error(`Quarantining invalid player data file `
                + `'${this.filePath}'`);
            return;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            this.fileQuarantined = true;
            console.error(`Quarantining invalid player data file `
                + `'${this.filePath}'`);
            return;
        }

        for (const [token, value] of Object.entries(raw)) {
            const migration = migratePlayerRecord(value);
            if (migration.kind === 'future') {
                console.error(`Quarantining player record '${token}': `
                    + `schema version ${migration.version} is newer than `
                    + `${CURRENT_PLAYER_RECORD_SCHEMA_VERSION}`);
                this.quarantinedPlayers.set(token, value);
                continue;
            }
            if (migration.kind === 'invalid-version'
                || !migration.value
                || typeof migration.value !== 'object'
                || Array.isArray(migration.value)) {
                console.warn(`Quarantining invalid player record '${token}'`);
                this.quarantinedPlayers.set(token, value);
                continue;
            }
            const migrated = migration.value as Record<string, unknown>;
            const snapshots: PlayerSnapshot[] = [];
            if (Array.isArray(migrated.snapshots)) {
                for (const [index, snapshot] of
                    migrated.snapshots.entries()) {
                    const decodedSnapshot =
                        PlayerSnapshotCodec.decode(snapshot);
                    if (decodedSnapshot._tag === 'Right') {
                        snapshots.push(cloneSnapshot(decodedSnapshot.right));
                    } else {
                        console.warn(`Dropping invalid snapshot ${index} `
                            + `from player record '${token}'`);
                    }
                }
            }
            const decoded = StoredPlayerCodec.decode({
                ...migrated,
                snapshots: Array.isArray(migrated.snapshots)
                    ? snapshots
                    : migrated.snapshots,
            });
            if (decoded._tag === 'Right') {
                this.players.set(token, normalizePlayer(decoded.right));
            } else {
                console.warn(`Quarantining invalid player record '${token}'`);
                this.quarantinedPlayers.set(token, value);
            }
        }
    }

    async get(token: string): Promise<StoredPlayer | undefined> {
        await this.ready;
        const player = this.players.get(token);
        return player ? clonePlayer(player) : undefined;
    }

    async getOrCreate(token: string): Promise<StoredPlayer> {
        await this.ready;
        this.assertWritable(token);
        let player = this.players.get(token);
        if (!player) {
            player = initialPlayerState();
            this.players.set(token, player);
            this.scheduleSave();
        }
        return clonePlayer(player);
    }

    /**
     * Persists a pilot's state. Pass `expectedRevision` to make the write
     * conditional: it is rejected if another writer has saved since that
     * revision was read.
     */
    async save(
        token: string,
        state: PersistentPlayerState,
        ship?: EncodedEntity,
        expectedRevision?: number,
    ): Promise<number> {
        await this.ready;
        this.assertWritable(token);
        const previous = this.players.get(token);
        const revision = previous?.revision ?? 0;
        if (expectedRevision !== undefined && expectedRevision !== revision) {
            throw new PlayerRevisionConflictError(expectedRevision, revision);
        }
        const persistedState = toPersistentPlayerState(state);
        const next = revision + 1;
        this.players.set(token, {
            ...persistedState,
            schemaVersion: CURRENT_PLAYER_RECORD_SCHEMA_VERSION,
            savedAt: Date.now(),
            snapshots: previous?.snapshots.map(cloneSnapshot) ?? [],
            ...(ship === undefined ? { ship: previous?.ship } : { ship }),
            revision: next,
        });
        this.scheduleSave();
        return next;
    }

    /** The revision a writer must present to save over the current state. */
    async revision(token: string): Promise<number> {
        await this.ready;
        return this.players.get(token)?.revision ?? 0;
    }

    /**
     * Retain a complete pilot-state snapshot. Saving first means a snapshot
     * taken during landing is also the state returned by Continue.
     */
    async snapshot(
        token: string,
        state: PersistentPlayerState,
        ship?: EncodedEntity,
        reason: PlayerSnapshot['reason'] = 'landing',
    ): Promise<PlayerSnapshot> {
        const persistedState = toPersistentPlayerState(state);
        await this.save(token, persistedState, ship);
        const player = this.players.get(token);
        if (!player) {
            throw new Error(`Missing player ${token} after saving snapshot`);
        }
        const createdAt = Date.now();
        const snapshot: PlayerSnapshot = {
            id: `${createdAt}-${++this.snapshotSequence}`,
            createdAt,
            reason,
            state: clonePlayerState(persistedState),
            ...(ship === undefined
                ? {}
                : {
                    ship: JSON.parse(JSON.stringify(ship)) as EncodedEntity,
                }),
        };
        player.snapshots = [
            ...player.snapshots,
            snapshot,
        ].slice(-MAX_PLAYER_SNAPSHOTS);
        this.scheduleSave();
        return cloneSnapshot(snapshot);
    }

    /**
     * Add a snapshot without updating the active pilot save. Used when the
     * menu archives one pilot before selecting another.
     */
    async archiveSnapshot(
        token: string,
        state: PersistentPlayerState,
        ship?: EncodedEntity,
        reason: PlayerSnapshot['reason'] = 'manual',
    ): Promise<PlayerSnapshot> {
        await this.ready;
        this.assertWritable(token);
        await this.getOrCreate(token);
        const persistedState = toPersistentPlayerState(state);
        const player = this.players.get(token);
        if (!player) {
            throw new Error(`Missing player ${token} after creating record`);
        }
        const createdAt = Date.now();
        const snapshot: PlayerSnapshot = {
            id: `${createdAt}-${++this.snapshotSequence}`,
            createdAt,
            reason,
            state: clonePlayerState(persistedState),
            ...(ship === undefined
                ? {}
                : {
                    ship: JSON.parse(JSON.stringify(ship)) as EncodedEntity,
                }),
        };
        player.snapshots = [
            ...player.snapshots,
            snapshot,
        ].slice(-MAX_PLAYER_SNAPSHOTS);
        this.scheduleSave();
        return cloneSnapshot(snapshot);
    }

    async getSnapshots(token: string): Promise<PlayerSnapshot[]> {
        await this.ready;
        return (this.players.get(token)?.snapshots ?? []).map(cloneSnapshot);
    }

    /**
     * Restore state while retaining the snapshot history, so a mistaken
     * restore can itself be undone from a later snapshot.
     */
    async restoreSnapshot(
        token: string,
        snapshotId: string,
    ): Promise<StoredPlayer | undefined> {
        await this.ready;
        const player = this.players.get(token);
        const snapshot = player?.snapshots.find(
            candidate => candidate.id === snapshotId);
        if (!player || !snapshot) {
            return undefined;
        }
        const restored = clonePlayerState(snapshot.state);
        delete restored.diedAt;
        this.players.set(token, {
            ...restored,
            schemaVersion: CURRENT_PLAYER_RECORD_SCHEMA_VERSION,
            savedAt: Date.now(),
            // A restore is a write. Advancing the revision makes a session
            // holding the pre-restore value fail instead of overwriting it.
            revision: (player.revision ?? 0) + 1,
            snapshots: player.snapshots.map(cloneSnapshot),
            // A snapshot taken before ships were stored has none. Keeping the
            // newer ship would pair it with an older pilot's state, so the
            // hull is rebuilt from the restored shipId instead.
            ...(snapshot.ship === undefined
                ? {}
                : {
                    ship: JSON.parse(JSON.stringify(snapshot.ship)) as EncodedEntity,
                }),
        });
        this.scheduleSave();
        return clonePlayer(this.players.get(token)!);
    }

    async getAllPilotsSummary(): Promise<Array<{
        token: string;
        pilotName: string;
        shipName: string;
        shipId: string;
        currentSystem: string;
        lastLandedPlanet?: string;
        lastLandedSystem?: string;
        kills: number;
        credits: number;
        savedAt?: number;
        isOnline: boolean;
    }>> {
        await this.ready;
        const onlineTokens = new Set(this.peerTokens.values());
        const entries = [];
        for (const [token, player] of this.players) {
            entries.push({
                token,
                pilotName: player.pilotName || 'Unknown Pilot',
                shipName: player.shipName || 'Vessel',
                shipId: player.shipId || 'nova:128',
                currentSystem: player.currentSystem || 'nova:130',
                lastLandedPlanet: player.lastLandedPlanet,
                lastLandedSystem: player.lastLandedSystem,
                kills: player.kills ?? 0,
                credits: player.credits ?? 0,
                savedAt: player.savedAt,
                isOnline: onlineTokens.has(token),
            });
        }
        return entries;
    }

    bindPeer(peerId: string, token: string) {
        this.peerTokens.set(peerId, token);
    }

    getTokenForPeer(peerId: string) {
        return this.peerTokens.get(peerId);
    }

    private scheduleSave() {
        this.dirty = true;
        if (this.saveTimer !== undefined) {
            return;
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            void this.flush().catch(error => {
                console.error(`Failed to save player data to ${this.filePath}`, error);
            });
        }, 100);
    }

    async flush() {
        await this.ready;
        while (true) {
            if (this.saveTimer !== undefined) {
                clearTimeout(this.saveTimer);
                this.saveTimer = undefined;
            }
            if (!this.dirty) {
                await this.writePromise;
                if (!this.dirty) {
                    return;
                }
                continue;
            }
            this.dirty = false;
            const write = this.writePromise.then(() => this.writeFile());
            this.writePromise = write.catch(() => {
                this.dirty = true;
            });
            await write;
        }
    }

    private async writeFile() {
        if (this.fileQuarantined) {
            throw new PlayerDataFileQuarantinedError(this.filePath);
        }
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const records: Record<string, unknown> =
            Object.fromEntries(this.quarantinedPlayers);
        for (const [token, player] of this.players) {
            records[token] = player;
        }
        const contents = JSON.stringify(records, null, 2) + '\n';
        const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        let renamed = false;
        try {
            await fs.writeFile(temporaryPath, contents, {
                encoding: 'utf8',
                mode: 0o600,
            });
            await fs.rename(temporaryPath, this.filePath);
            renamed = true;
        } finally {
            if (!renamed) {
                await fs.rm(temporaryPath, { force: true }).catch(() => {
                    // Cleanup must not replace the persistence failure.
                });
            }
        }
    }

    async quarantine(token: string): Promise<PlayerQuarantine> {
        await this.ready;
        if (this.fileQuarantined) {
            return 'file';
        }
        return this.quarantinedPlayers.has(token) ? 'record' : 'none';
    }

    private assertWritable(token: string) {
        if (this.fileQuarantined) {
            throw new PlayerDataFileQuarantinedError(this.filePath);
        }
        if (this.quarantinedPlayers.has(token)) {
            throw new PlayerRecordQuarantinedError(token);
        }
    }
}

