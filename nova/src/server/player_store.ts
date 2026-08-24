import * as t from 'io-ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PLAYER_DATA_DIRECTORY = 'NovaJS-data';
const PLAYER_DATA_FILE = 'players.json';
const MAX_MISSION_BITS = 10_000;

export interface PersistentActiveMission {
    missionId: string;
    state: string;
}

export interface PersistentPlayerState {
    credits: number;
    missionBits: boolean[];
    gameDate: number;
    activeMissions: PersistentActiveMission[];
    shipId: string;
    currentSystem: string;
}

export interface StoredPlayer extends PersistentPlayerState {
    /** Reserved for a future fully serialized ship restore. */
    ship?: unknown;
}

const ActiveMission = t.type({
    missionId: t.string,
    state: t.string,
});

const StoredPlayerCodec = t.intersection([
    t.type({
        credits: t.number,
        missionBits: t.array(t.boolean),
        gameDate: t.number,
        activeMissions: t.array(ActiveMission),
        shipId: t.string,
        currentSystem: t.string,
    }),
    t.partial({
        ship: t.unknown,
    }),
]);

function defaultPlayerDataPath() {
    const configured = process.env.NOVA_PLAYER_DATA
        ?? path.join(os.homedir(), PLAYER_DATA_DIRECTORY, PLAYER_DATA_FILE);
    return configured.startsWith('~/')
        ? path.join(os.homedir(), configured.slice(2))
        : path.resolve(configured);
}

function initialPlayerState(): PersistentPlayerState {
    return {
        credits: 10_000,
        missionBits: new Array<boolean>(MAX_MISSION_BITS).fill(false),
        gameDate: 0,
        activeMissions: [],
        shipId: 'nova:128',
        currentSystem: 'nova:130',
    };
}

function clonePlayer(player: StoredPlayer): StoredPlayer {
    return {
        ...player,
        missionBits: [...player.missionBits],
        activeMissions: player.activeMissions.map(mission => ({ ...mission })),
    };
}

/**
 * Debounced JSON persistence for player state.
 *
 * The file is replaced with rename(2) after every debounce window. The
 * in-memory map is keyed by the client-provided persistent token; transport
 * peer IDs are tracked separately and are never written as player identity.
 */
export class PlayerStore {
    readonly filePath: string;
    readonly ready: Promise<void>;
    private players = new Map<string, StoredPlayer>();
    private peerTokens = new Map<string, string>();
    private saveTimer?: NodeJS.Timeout;
    private writePromise: Promise<void> = Promise.resolve();
    private dirty = false;

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
                this.players.set(token, decoded.right);
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

    async save(token: string, state: PersistentPlayerState, ship?: unknown) {
        await this.ready;
        this.players.set(token, {
            ...state,
            missionBits: [...state.missionBits],
            activeMissions: state.activeMissions.map(mission => ({ ...mission })),
            ...(ship === undefined ? {} : { ship }),
        });
        this.scheduleSave();
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

