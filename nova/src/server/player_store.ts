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
    PlayerStorePort,
} from '../nova_plugin/player_state';

export { PlayerRevisionConflictError };
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';

const PLAYER_DATA_DIRECTORY = 'NovaJS-data';
const PLAYER_DATA_FILE = 'players.json';
export const MAX_PLAYER_SNAPSHOTS = 10;

export interface StoredPlayer extends PersistentPlayerState {
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
    t.partial({
        savedAt: t.number,
        ship: EncodedEntity,
        snapshots: t.array(PlayerSnapshotCodec),
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
        ...(player.savedAt === undefined ? {} : { savedAt: player.savedAt }),
        ...(player.ship === undefined
            ? {}
            : { ship: JSON.parse(JSON.stringify(player.ship)) as EncodedEntity }),
        snapshots: (player.snapshots ?? []).map(cloneSnapshot),
    };
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
    private peerTokens = new Map<string, string>();
    private saveTimer?: NodeJS.Timeout;
    private writePromise: Promise<void> = Promise.resolve();
    private dirty = false;
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
            console.warn(`Ignoring invalid player data in ${this.filePath}`);
            return;
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            console.warn(`Ignoring invalid player data in ${this.filePath}`);
            return;
        }

        for (const [token, value] of Object.entries(raw)) {
            const decoded = StoredPlayerCodec.decode(value);
            if (decoded._tag === 'Right') {
                this.players.set(token, normalizePlayer(decoded.right));
            } else {
                console.warn(`Ignoring invalid player record '${token}'`);
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
        const previous = this.players.get(token);
        const revision = previous?.revision ?? 0;
        if (expectedRevision !== undefined && expectedRevision !== revision) {
            throw new PlayerRevisionConflictError(expectedRevision, revision);
        }
        const persistedState = toPersistentPlayerState(state);
        const next = revision + 1;
        this.players.set(token, {
            ...persistedState,
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
            savedAt: Date.now(),
            snapshots: player.snapshots.map(cloneSnapshot),
            ...(snapshot.ship === undefined
                ? {}
                : {
                    ship: JSON.parse(JSON.stringify(snapshot.ship)) as EncodedEntity,
                }),
        });
        this.scheduleSave();
        return clonePlayer(this.players.get(token)!);
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
        if (this.saveTimer !== undefined) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        if (!this.dirty) {
            await this.writePromise;
            return;
        }
        this.dirty = false;
        this.writePromise = this.writePromise.then(() => this.writeFile());
        await this.writePromise;
    }

    private async writeFile() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const contents = JSON.stringify(Object.fromEntries(this.players), null, 2)
            + '\n';
        const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(temporaryPath, contents, {
            encoding: 'utf8',
            mode: 0o600,
        });
        await fs.rename(temporaryPath, this.filePath);
    }
}

