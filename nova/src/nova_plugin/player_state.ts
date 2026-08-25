import { Either } from 'fp-ts/Either';
import * as t from 'io-ts';
import { Errors } from 'io-ts';
import { Component } from 'nova_ecs/component';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import {
    resourceId as canonicalResourceId,
    sameResourceId,
} from '../common/resource_id';
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';

export const MAX_MISSION_BITS = 10_000;
export const EV_NOVA_START_YEAR = 1177;
export const EV_NOVA_START_MONTH = 10;
export const EV_NOVA_START_DAY = 18;

export const MAX_ACTIVE_MISSIONS = 16;
export const DEFAULT_CARGO_CAPACITY = 10;

export const MissionState = t.union([
    t.literal('active'),
    t.literal('completed'),
    t.literal('failed'),
    t.literal('aborted'),
]);
export type MissionState = t.TypeOf<typeof MissionState>;

export const MissionCargo = t.intersection([
    t.type({
        type: t.number,
        quantity: t.number,
    }),
    t.partial({
        pickupDestination: t.string,
    }),
]);
export type MissionCargo = t.TypeOf<typeof MissionCargo>;

export const CargoHold = t.type({
    commodity: t.string,
    tons: t.number,
    isMissionCargo: t.boolean,
});
export type CargoHold = t.TypeOf<typeof CargoHold>;

const ActiveMission = t.type({
    missionId: t.string,
    state: MissionState,
});
const ActiveMissionDetails = t.intersection([
    ActiveMission,
    t.partial({
        // Optional during decode to keep player files from phase one
        // backward-compatible. New missions always write both fields.
        destination: t.string,
        travelDestination: t.string,
        returnDestination: t.string,
        shipSystem: t.string,
        cargo: MissionCargo,
        acceptedDate: t.number,
        missionUuid: t.string,
        shipGoalProgress: t.type({
            goal: t.number,
            total: t.number,
            destroyed: t.number,
            disabled: t.number,
            boarded: t.number,
            observed: t.number,
            lost: t.number,
            completed: t.boolean,
            shipDoneApplied: t.boolean,
        }),
        // Procedural missions do not exist in the mïsn resource catalog. The
        // complete synthetic MissionData record is persisted with the entry.
        missionData: t.any,
    }),
]);
export type ActiveMission = t.TypeOf<typeof ActiveMissionDetails>;

export interface MissionGoalProgress {
    goal: number;
    total: number;
    destroyed: number;
    disabled: number;
    boarded: number;
    observed: number;
    lost: number;
    completed: boolean;
    shipDoneApplied: boolean;
}

export function createMissionGoalProgress(
    goal: number,
    total: number,
): MissionGoalProgress {
    return {
        goal,
        total: Math.max(0, Math.floor(total)),
        destroyed: 0,
        disabled: 0,
        boarded: 0,
        observed: 0,
        lost: 0,
        completed: total <= 0,
        shipDoneApplied: false,
    };
}

/**
 * A boolean array is used instead of a Set so Immer can track changes and the
 * ECS serializer can send the component between client and server worlds.
 */
const PlayerStateFields = t.intersection([
    t.type({
        credits: t.number,
        missionBits: t.array(t.boolean),
        gameDate: t.number,
        activeMissions: t.array(ActiveMissionDetails),
        shipId: t.string,
        currentSystem: t.string,
        lastLandedPlanet: t.string,
        lastLandedSystem: t.string,
        lastLandedPosition: t.tuple([t.number, t.number]),
        cargoCapacity: t.number,
        holds: t.array(CargoHold),
        pilotName: t.string,
        shipName: t.string,
        gender: t.union([t.literal('male'), t.literal('female')]),
        destroyedStellars: t.array(t.string),
        activeRanks: t.array(t.number),
        exploredSystems: t.array(t.string),
    }),
    t.partial({
        registered: t.boolean,
        daysSinceRegistration: t.number,
    }),
]);
type PlayerStateFields = t.TypeOf<typeof PlayerStateFields>;
export type PersistentPlayerState = PlayerStateFields;
export type PlayerState = PlayerStateFields & {
    /** Derived getter; it is intentionally excluded from persisted state. */
    readonly freeSpace: number;
};

/**
 * Decode both current state and the phase-one state shape. The output always
 * has the current cargo fields, so callers do not need optional checks after a
 * player has crossed the persistence/wire boundary.
 */
const LegacyPlayerStateFields = t.intersection([
    t.type({
        credits: t.number,
        missionBits: t.array(t.boolean),
        gameDate: t.number,
        activeMissions: t.array(ActiveMissionDetails),
        shipId: t.string,
        currentSystem: t.string,
    }),
    t.partial({
        cargoCapacity: t.number,
        holds: t.array(CargoHold),
        pilotName: t.string,
        shipName: t.string,
        gender: t.union([t.literal('male'), t.literal('female')]),
        lastLandedPlanet: t.string,
        lastLandedSystem: t.string,
        lastLandedPosition: t.tuple([t.number, t.number]),
        destroyedStellars: t.array(t.string),
        activeRanks: t.array(t.number),
        exploredSystems: t.array(t.string),
        registered: t.boolean,
        daysSinceRegistration: t.number,
    }),
]);

function decodePersistentPlayerState(
    value: unknown,
    context: t.Context,
): Either<Errors, PersistentPlayerState> {
    const decoded = LegacyPlayerStateFields.validate(value, context);
    if (decoded._tag === 'Left') {
        return decoded;
    }
    const state = {
        ...decoded.right,
        cargoCapacity: Number.isFinite(decoded.right.cargoCapacity)
            ? decoded.right.cargoCapacity
            : DEFAULT_CARGO_CAPACITY,
        holds: decoded.right.holds ?? [],
        pilotName: decoded.right.pilotName ?? 'Captain',
        shipName: decoded.right.shipName ?? 'Nova',
        gender: decoded.right.gender ?? 'male',
        lastLandedPlanet: decoded.right.lastLandedPlanet ?? 'nova:128',
        lastLandedSystem: decoded.right.lastLandedSystem
            ?? decoded.right.currentSystem,
        lastLandedPosition: decoded.right.lastLandedPosition ?? [0, 0],
        destroyedStellars: decoded.right.destroyedStellars ?? [],
        activeRanks: decoded.right.activeRanks ?? [],
        exploredSystems: decoded.right.exploredSystems ?? [],
    } as PersistentPlayerState;
    migrateMissionCargo(state);
    return t.success(state);
}

function encodePersistentPlayerState(
    state: PersistentPlayerState,
): PersistentPlayerState {
    return PlayerStateFields.encode(state) as PersistentPlayerState;
}

/**
 * The sole schema for data retained by PlayerStore and its snapshots.
 *
 * This codec intentionally excludes `freeSpace`, which is a derived runtime
 * getter. Keeping the codec here makes the schema available to browser code
 * without importing the Node filesystem implementation.
 */
export const PersistentPlayerStateCodec =
    new t.Type<PersistentPlayerState>(
    'PersistentPlayerStateCodec',
    (value): value is PersistentPlayerState => PlayerStateFields.is(value),
    decodePersistentPlayerState,
    encodePersistentPlayerState,
);

export const PlayerStateCodec = new t.Type<
    PlayerState,
    PersistentPlayerState
>(
    'PlayerStateCodec',
    (value): value is PlayerState => PlayerStateFields.is(value),
    (value, context) => {
        const decoded = decodePersistentPlayerState(value, context);
        if (decoded._tag === 'Left') {
            return decoded;
        }
        return t.success(withComputedFreeSpace(decoded.right));
    },
    state => encodePersistentPlayerState(state),
);

export function decodePlayerState(
    raw: unknown,
): Either<Errors, PlayerState> {
    return PlayerStateCodec.decode(raw);
}

export function toPersistentPlayerState(
    state: PlayerState | PersistentPlayerState,
): PersistentPlayerState {
    const decoded = PersistentPlayerStateCodec.decode(state);
    if (decoded._tag === 'Left') {
        throw new Error('Cannot persist invalid player state');
    }
    // Runtime state is commonly an Immer draft. Encoding alone preserves
    // references to draft-backed arrays and objects; the draft is revoked at
    // the end of the ECS step, before an async PlayerStore save resumes.
    // Detach the canonical encoded shape synchronously so persistence never
    // observes revoked proxies.
    return JSON.parse(JSON.stringify(
        encodePersistentPlayerState(decoded.right),
    )) as PersistentPlayerState;
}

/**
 * Clone via the canonical encoded shape rather than another hand-maintained
 * list of state fields. Player data is JSON persistence data by definition.
 */
export function clonePlayerState(
    state: PersistentPlayerState,
): PersistentPlayerState {
    return JSON.parse(JSON.stringify(
        PersistentPlayerStateCodec.encode(state))) as PersistentPlayerState;
}

export const PlayerStateComponent =
    new Component<PlayerState>('PlayerStateComponent');
export const PlayerStateResource =
    new Resource<PlayerState>('PlayerStateResource');

/**
 * The server-only PlayerStore is provided through this resource without
 * making browser bundles import its Node fs implementation.
 */
export const PlayerStoreResource =
    new Resource<PlayerStorePort>('PlayerStoreResource');

export const PlayerSnapshotSummary = t.intersection([
    t.type({
        id: t.string,
        createdAt: t.number,
        reason: t.union([t.literal('landing'), t.literal('manual')]),
    }),
    t.partial({
        pilotName: t.string,
        currentSystem: t.string,
    }),
]);
export type PlayerSnapshotSummary = t.TypeOf<typeof PlayerSnapshotSummary>;

export const PlayerSnapshotCodec = t.intersection([
    t.type({
        id: t.string,
        createdAt: t.number,
        reason: t.union([t.literal('landing'), t.literal('manual')]),
        state: PersistentPlayerStateCodec,
    }),
    t.partial({
        ship: EncodedEntity,
    }),
]);
export type PlayerSnapshot = t.TypeOf<typeof PlayerSnapshotCodec>;

/**
 * Shared port implemented by the Node store and consumed by gameplay
 * plugins. Keeping this contract beside the browser-safe codecs prevents
 * each plugin from inventing a slightly different persistence API.
 */
export interface PlayerStorePort {
    readonly ready: Promise<void>;
    get(token: string): Promise<
        (PersistentPlayerState & { readonly savedAt?: number }) | undefined
    >;
    getOrCreate(token: string): Promise<PersistentPlayerState>;
    save(
        token: string,
        state: PersistentPlayerState,
        ship?: t.TypeOf<typeof EncodedEntity>,
    ): Promise<void>;
    snapshot(
        token: string,
        state: PersistentPlayerState,
        ship?: t.TypeOf<typeof EncodedEntity>,
        reason?: PlayerSnapshot['reason'],
    ): Promise<PlayerSnapshot>;
    getSnapshots(token: string): Promise<PlayerSnapshot[]>;
    restoreSnapshot(
        token: string,
        snapshotId: string,
    ): Promise<{ readonly currentSystem: string } | undefined>;
    bindPeer(peerId: string, token: string): void;
    getTokenForPeer(peerId: string): string | undefined;
    flush(): Promise<void>;
}

/**
 * Message sent by the server after the normal communicator UUID handshake.
 * All fields besides uuid are optional so older servers/clients remain
 * compatible with the existing communicator protocol.
 */
export const PlayerData = t.intersection([
    t.type({
        uuid: t.string,
    }),
    t.partial({
        system: t.string,
        savedAt: t.number,
        playerState: PlayerStateCodec,
        ship: EncodedEntity,
        snapshots: t.array(PlayerSnapshotSummary),
    }),
]);
export type PlayerData = t.TypeOf<typeof PlayerData>;

export function createInitialPlayerState(): PlayerState {
    return withComputedFreeSpace({
        credits: 10_000,
        missionBits: new Array<boolean>(MAX_MISSION_BITS).fill(false),
        gameDate: 0,
        activeMissions: [],
        shipId: 'nova:128',
        currentSystem: 'nova:130',
        lastLandedPlanet: 'nova:128',
        lastLandedSystem: 'nova:130',
        lastLandedPosition: [0, 0],
        cargoCapacity: DEFAULT_CARGO_CAPACITY,
        holds: [],
        pilotName: 'Captain',
        shipName: 'Nova',
        gender: 'male',
        destroyedStellars: [],
        activeRanks: [],
        exploredSystems: [],
        registered: false,
    });
}

function withComputedFreeSpace(state: PlayerStateFields): PlayerState {
    Object.defineProperty(state, 'freeSpace', {
        configurable: true,
        enumerable: false,
        get: function(this: PlayerStateFields) {
            return getFreeSpace(this);
        },
    });
    return state as PlayerState;
}

export function cargoTons(state: Pick<PlayerState, 'holds'>): number {
    return state.holds.reduce((total, hold) =>
        total + Math.max(0, Number.isFinite(hold.tons) ? hold.tons : 0), 0);
}

/**
 * Free cargo is derived from the ship's total capacity and current holds.
 * Returning zero for an over-capacity legacy save prevents new cargo from
 * making the discrepancy worse while still allowing missions to complete.
 */
export function getFreeSpace(
    state: Pick<PlayerState, 'cargoCapacity' | 'holds'>,
): number {
    return Math.max(0, Math.floor(
        state.cargoCapacity - cargoTons(state)));
}

/** Short alias matching the terminology used by the EV Nova UI. */
export const freeSpace = getFreeSpace;

export function setCargoCapacity(
    state: PlayerState,
    cargoCapacity: number,
): number {
    if (Number.isFinite(cargoCapacity) && cargoCapacity >= 0) {
        state.cargoCapacity = Math.floor(cargoCapacity);
    }
    return state.cargoCapacity;
}

export function isStellarDestroyed(
    state: Pick<PlayerState, 'destroyedStellars'>,
    id: string | number,
): boolean {
    const resourceId = canonicalResourceId(id);
    return state.destroyedStellars.some(entry =>
        sameResourceId(entry, resourceId));
}

export function destroyStellar(
    state: PlayerState,
    id: string | number,
): void {
    if (!isStellarDestroyed(state, id)) {
        state.destroyedStellars.push(canonicalResourceId(id));
    }
}

export function regenerateStellar(
    state: PlayerState,
    id: string | number,
): void {
    state.destroyedStellars = state.destroyedStellars.filter(entry =>
        !sameResourceId(entry, canonicalResourceId(id)));
}

export function activateRank(state: PlayerState, id: number): void {
    if (!state.activeRanks.includes(id)) {
        state.activeRanks.push(id);
    }
}

export function deactivateRank(state: PlayerState, id: number): void {
    state.activeRanks = state.activeRanks.filter(rank => rank !== id);
}

export function exploreSystem(state: PlayerState, id: string | number): void {
    const systemId = canonicalResourceId(id);
    if (!state.exploredSystems.some(entry =>
        sameResourceId(entry, systemId))) {
        state.exploredSystems.push(systemId);
    }
}

/**
 * Add physical cargo without allowing mission cargo to be traded away.
 * Identical ordinary holds are coalesced; mission holds remain keyed by
 * mission id so release is exact.
 */
export function allocateCargo(
    state: PlayerState,
    hold: CargoHold,
): boolean {
    const tons = Math.floor(hold.tons);
    if (tons <= 0 || getFreeSpace(state) < tons) {
        return false;
    }
    const existing = state.holds.find(existing =>
        existing.commodity === hold.commodity
        && existing.isMissionCargo === hold.isMissionCargo);
    if (existing) {
        existing.tons += tons;
    } else {
        state.holds.push({
            commodity: hold.commodity,
            tons,
            isMissionCargo: hold.isMissionCargo,
        });
    }
    return true;
}

/**
 * Release up to `tons` from matching cargo and return the amount removed.
 * Mission cargo is excluded unless callers explicitly request it.
 */
export function releaseCargo(
    state: PlayerState,
    commodity: string,
    tons = Infinity,
    isMissionCargo = false,
): number {
    let remaining = Number.isFinite(tons) ? Math.max(0, tons) : Infinity;
    let released = 0;
    for (let index = state.holds.length - 1; index >= 0 && remaining > 0; index--) {
        const hold = state.holds[index];
        if (hold.commodity !== commodity
            || hold.isMissionCargo !== isMissionCargo) {
            continue;
        }
        const amount = Math.min(hold.tons, remaining);
        hold.tons -= amount;
        released += amount;
        remaining -= amount;
        if (hold.tons <= 0) {
            state.holds.splice(index, 1);
        }
    }
    return released;
}

export function releaseMissionCargo(
    state: PlayerState,
    missionId: string,
): number {
    return releaseCargo(state, missionId, Infinity, true);
}

function migrateMissionCargo(state: Pick<PlayerState, 'activeMissions' | 'holds'>) {
    for (const mission of state.activeMissions) {
        if (mission.state !== 'active' || !mission.cargo
            || mission.cargo.quantity <= 0
            || state.holds.some(hold =>
                hold.isMissionCargo && hold.commodity === mission.missionId)) {
            continue;
        }
        // Old saves stored cargo only on ActiveMission. Keep it in the hold
        // during migration; a later capacity sync can expose it as full.
        state.holds.push({
            commodity: mission.missionId,
            tons: mission.cargo.quantity,
            isMissionCargo: true,
        });
    }
}

export function advanceGameDate(state: PlayerState, days = 1): number {
    if (!Number.isInteger(days) || days < 0) {
        throw new Error('Game date can only advance by a non-negative integer');
    }
    state.gameDate += days;
    return state.gameDate;
}

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_MS = 24 * 60 * 60 * 1000;
const START_DATE_MS = Date.UTC(
    EV_NOVA_START_YEAR, EV_NOVA_START_MONTH - 1, EV_NOVA_START_DAY);

export function formatGameDate(gameDate: number): string {
    if (!Number.isInteger(gameDate) || gameDate < 0) {
        throw new Error('Game date must be a non-negative integer');
    }
    const date = new Date(START_DATE_MS + gameDate * DAY_MS);
    return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} `
        + `${date.getUTCFullYear()} NC`;
}

export const PlayerStatePlugin: Plugin = {
    name: 'PlayerStatePlugin',
    build(world) {
        world.addComponent(PlayerStateComponent);
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        deltaMaker.addComponent(PlayerStateComponent, {
            componentType: PlayerStateCodec,
        });
    },
};

