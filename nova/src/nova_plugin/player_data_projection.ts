import { isRight } from 'fp-ts/Either';
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';
import {
    PersistentPlayerState,
    PlayerData,
    PlayerQuarantine,
    PlayerSnapshot,
    PlayerSnapshotSummary,
    PlayerState,
    PlayerStateCodec,
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
    const state = decoded.right;
    const persisted: PersistentPlayerState = {
        credits: state.credits,
        missionBits: state.missionBits,
        gameDate: state.gameDate,
        activeMissions: state.activeMissions,
        shipId: state.shipId,
        currentSystem: state.currentSystem,
        lastLandedPlanet: state.lastLandedPlanet,
        lastLandedSystem: state.lastLandedSystem,
        lastLandedPosition: state.lastLandedPosition,
        cargoCapacity: state.cargoCapacity,
        holds: state.holds,
        pilotName: state.pilotName,
        shipName: state.shipName,
        gender: state.gender,
        destroyedStellars: state.destroyedStellars,
        activeRanks: state.activeRanks,
        exploredSystems: state.exploredSystems,
        ...(state.registered === undefined
            ? {} : { registered: state.registered }),
        ...(state.daysSinceRegistration === undefined
            ? {} : { daysSinceRegistration: state.daysSinceRegistration }),
        ...(state.landingCount === undefined
            ? {} : { landingCount: state.landingCount }),
        ...(state.kills === undefined ? {} : { kills: state.kills }),
        ...(state.fuel === undefined ? {} : { fuel: state.fuel }),
        ...(state.legalRecords === undefined
            ? {} : { legalRecords: state.legalRecords }),
        ...(state.escorts === undefined ? {} : { escorts: state.escorts }),
        ...(state.diedAt === undefined ? {} : { diedAt: state.diedAt }),
    };
    const projected = PlayerStateCodec.decode(persisted);
    if (!isRight(projected)) {
        throw new Error('Could not project persisted player state');
    }
    return projected.right;
}

export function summarizeSnapshots(
    snapshots: readonly PlayerSnapshot[],
): PlayerSnapshotSummary[] {
    return snapshots.map(({ id, createdAt, reason, state }) => ({
        id,
        createdAt,
        reason,
        pilotName: state.pilotName,
        currentSystem: state.currentSystem,
    }));
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
