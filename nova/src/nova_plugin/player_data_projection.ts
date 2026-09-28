import { isRight } from 'nova_ecs/either';
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';
import {
    PersistentPlayerState,
    PlayerData,
    PlayerQuarantine,
    PlayerSnapshot,
    PlayerSnapshotSummary,
    PlayerState,
    PlayerStateCodec,
    toPersistentPlayerState,
} from './player_state';

export interface StoredPlayerData {
    state?: unknown;
    savedAt?: number;
    ship?: unknown;
    snapshots?: readonly PlayerSnapshot[];
    quarantine?: PlayerQuarantine;
}

function projectPlayerState(raw: unknown): PlayerState {
    const decoded = PlayerStateCodec.decode(raw);
    if (!isRight(decoded)) {
        throw new Error('Invalid persisted player state');
    }
    // The codec is the one schema: a hand-kept field list here silently
    // dropped newer fields (crön state, combat balances) on every reload.
    const persisted: PersistentPlayerState = toPersistentPlayerState(decoded.right);
    const projected = PlayerStateCodec.decode(persisted);
    if (!isRight(projected)) {
        throw new Error('Could not project persisted player state');
    }
    return projected.right;
}

export function summarizeSnapshot(
    snapshot: PlayerSnapshot,
): PlayerSnapshotSummary {
    const { id, createdAt, reason, state } = snapshot;
    return {
        id,
        createdAt,
        reason,
        pilotName: state.pilotName,
        currentSystem: state.currentSystem,
        ...(state.diedAt === undefined ? {} : { diedAt: state.diedAt }),
    };
}

export function summarizeSnapshots(
    snapshots: readonly PlayerSnapshot[],
): PlayerSnapshotSummary[] {
    return snapshots.map(summarizeSnapshot);
}

export function makePlayerData(
    uuid: string,
    stored: StoredPlayerData | undefined,
): PlayerData {
    if (!stored) {
        return { uuid };
    }
    const quarantine = stored.quarantine !== undefined
        && stored.quarantine !== 'none'
        ? { quarantine: stored.quarantine }
        : {};
    if (stored.state === undefined) {
        return { uuid, ...quarantine };
    }
    const playerState = projectPlayerState(stored.state);
    const data: PlayerData = {
        uuid,
        system: playerState.currentSystem,
        playerState,
        snapshots: summarizeSnapshots(stored.snapshots ?? []),
        ...(stored.savedAt === undefined
            ? {} : { savedAt: stored.savedAt }),
        ...quarantine,
    };
    if (stored.ship !== undefined) {
        const ship = EncodedEntity.decode(stored.ship);
        if (isRight(ship)) {
            data.ship = ship.right;
        }
    }
    return data;
}
