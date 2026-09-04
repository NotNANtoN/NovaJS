import { Either } from 'nova_ecs/either';
import * as t from 'io-ts';
import { FUEL_PER_JUMP } from './fuel';
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
        // Set when the pilot lands at TravelStel. ReturnStel completions
        // require this so a story mission cannot pay out without the visit.
        travelVisited: t.boolean,
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
/**
 * A standing escort contract. This lives with the persisted state rather than
 * with EscortPlugin so that a hired wing survives a session; the plugin reads
 * the shape from here to keep the two from drifting apart.
 */
export const EscortContractData = t.type({
    id: t.string,
    shipId: t.string,
    dailyPay: t.number,
});
export type EscortContract = t.TypeOf<typeof EscortContractData>;

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
        /** How many times this pilot has landed; shown on the ship info. */
        landingCount: t.number,
        /** Ships this pilot has destroyed; drives the combat rating. */
        kills: t.number,
        /** Jump fuel in retail units; 100 units is one hyperspace jump. */
        fuel: t.number,
        /**
         * Signed legal record per government resource id. A government with
         * no entry falls back to its own InitialRecord.
         */
        legalRecords: t.record(t.string, t.number),
        /** Escorts under contract, each drawing its daily pay. */
        escorts: t.array(EscortContractData),
        dominatedStellars: t.array(t.string),
        diedAt: t.number,
    }),
]);
type PlayerStateFields = t.TypeOf<typeof PlayerStateFields>;
export type PersistentPlayerState = PlayerStateFields;
export type PlayerState = PlayerStateFields & {
    /** Derived getter; it is intentionally excluded from persisted state. */
    readonly freeSpace: number;
};

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
    (value, context) => PlayerStateFields.validate(value, context),
    encodePersistentPlayerState,
);

export const PlayerStateCodec = new t.Type<
    PlayerState,
    PersistentPlayerState
>(
    'PlayerStateCodec',
    (value): value is PlayerState => PlayerStateFields.is(value),
    (value, context) => {
        const decoded = PersistentPlayerStateCodec.validate(value, context);
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
        diedAt: t.number,
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
/**
 * Raised when a save is based on state the store has already moved past,
 * which happens when a pilot reconnects while the previous session is still
 * flushing. The newer state wins and the stale write is dropped.
 */
export class PlayerRevisionConflictError extends Error {
    constructor(readonly expected: number, readonly actual: number) {
        super(`Player state revision ${expected} is stale; `
            + `the store is at ${actual}`);
    }
}

/**
 * Why a pilot's saved data is being withheld. `record` is one unreadable
 * pilot; `file` is an unreadable store, which withholds every pilot.
 */
export const PlayerQuarantine = t.union([
    t.literal('none'),
    t.literal('record'),
    t.literal('file'),
]);
export type PlayerQuarantine = t.TypeOf<typeof PlayerQuarantine>;

/** A pilot's persisted state together with the store's own bookkeeping. */
export type StoredPlayerRecord = PersistentPlayerState & {
    readonly savedAt?: number,
    readonly revision?: number,
    readonly ship?: t.TypeOf<typeof EncodedEntity>,
    readonly snapshots?: readonly PlayerSnapshot[],
};

export interface PilotDirectoryEntry {
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
}

export interface PlayerStorePort {
    readonly ready: Promise<void>;
    get(token: string): Promise<StoredPlayerRecord | undefined>;
    getOrCreate(token: string): Promise<PersistentPlayerState>;
    /**
     * Persists a pilot's state, returning the revision the store is now at.
     * Passing `expectedRevision` makes the write conditional so a session
     * that has fallen behind cannot overwrite newer progress.
     */
    save(
        token: string,
        state: PersistentPlayerState,
        ship?: t.TypeOf<typeof EncodedEntity>,
        expectedRevision?: number,
    ): Promise<number | void>;
    /** The revision a conditional save must present. */
    revision?(token: string): Promise<number>;
    /**
     * Whether a pilot's saved data was held back rather than served. A
     * quarantined token refuses every write, so callers must tell the pilot
     * instead of letting them play a session that cannot be saved.
     */
    quarantine?(token: string): Promise<PlayerQuarantine>;
    snapshot(
        token: string,
        state: PersistentPlayerState,
        ship?: t.TypeOf<typeof EncodedEntity>,
        reason?: PlayerSnapshot['reason'],
    ): Promise<PlayerSnapshot>;
    /**
     * Retain pilot state in snapshot history without making it the active save.
     * Used when switching pilots from the main menu.
     */
    archiveSnapshot(
        token: string,
        state: PersistentPlayerState,
        ship?: t.TypeOf<typeof EncodedEntity>,
        reason?: PlayerSnapshot['reason'],
    ): Promise<PlayerSnapshot>;
    getSnapshots(token: string): Promise<PlayerSnapshot[]>;
    restoreSnapshot(
        token: string,
        snapshotId: string,
    ): Promise<StoredPlayerRecord | undefined>;
    getAllPilotsSummary?(): Promise<PilotDirectoryEntry[]>;
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
        /**
         * Set when saved data was withheld rather than served. The pilot must
         * be told, because a session started over it cannot be saved.
         */
        quarantine: PlayerQuarantine,
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
        kills: 0,
        dominatedStellars: [],
        // A new pilot's Shuttle carries three jumps.
        fuel: 3 * FUEL_PER_JUMP,
        legalRecords: {},
        // Retail's `P` test asks whether the copy is registered. A full data
        // set is not the demo, and leaving this false hides every ship,
        // outfit and mission behind a `P` gate.
        registered: true,
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

export function advanceGameDate(state: PlayerState, days = 1): number {
    if (!Number.isInteger(days) || days < 0) {
        throw new Error('Game date can only advance by a non-negative integer');
    }
    state.gameDate += days;
    for (let day = 0; day < days; day++) {
        chargeEscortPayroll(state);
        collectTribute(state);
    }
    return state.gameDate;
}

/** What a day of the pilot's hired wing costs. */
export function escortPayrollDue(
    state: Pick<PlayerState, 'escorts'>,
): number {
    return (state.escorts ?? []).reduce(
        (sum, contract) => sum + Math.max(0, Math.floor(contract.dailyPay)), 0);
}

/**
 * Take a day's escort pay out of the pilot's credits.
 *
 * An escort that cannot be paid does not work for free. Retail gives no rule
 * for who leaves first, so the most recently hired contract is dropped until
 * the remaining wing is affordable, which keeps the escorts a pilot has flown
 * with longest.
 */
export function chargeEscortPayroll(state: PlayerState): {
    paid: number;
    dismissed: EscortContract[];
} {
    const dismissed: EscortContract[] = [];
    let escorts = [...(state.escorts ?? [])];
    while (escorts.length
        && escortPayrollDue({ escorts }) > state.credits) {
        const dropped = escorts.pop();
        if (dropped) {
            dismissed.unshift(dropped);
        }
    }
    const paid = escortPayrollDue({ escorts });
    if (dismissed.length) {
        state.escorts = escorts;
    }
    state.credits -= paid;
    return { paid, dismissed };
}

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_MS = 24 * 60 * 60 * 1000;
export const START_DATE_MS = Date.UTC(
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


/** Collects daily tribute from dominated planets. */
export function collectTribute(state: PlayerState, tributePerStellar = 1000): number {
    if (!state.dominatedStellars || state.dominatedStellars.length === 0) {
        return 0;
    }
    const totalTribute = state.dominatedStellars.length * tributePerStellar;
    state.credits += totalTribute;
    return totalTribute;
}
