import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
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
        // Procedural missions do not exist in the mïsn resource catalog. The
        // complete synthetic MissionData record is persisted with the entry.
        missionData: t.any,
    }),
]);
export type ActiveMission = t.TypeOf<typeof ActiveMissionDetails>;

/**
 * A boolean array is used instead of a Set so Immer can track changes and the
 * ECS serializer can send the component between client and server worlds.
 */
const PlayerStateFields = t.type({
    credits: t.number,
    missionBits: t.array(t.boolean),
    gameDate: t.number,
    activeMissions: t.array(ActiveMissionDetails),
    shipId: t.string,
    currentSystem: t.string,
    cargoCapacity: t.number,
    holds: t.array(CargoHold),
});
type PlayerStateFields = t.TypeOf<typeof PlayerStateFields>;
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
    }),
]);

export const PlayerStateCodec = new t.Type<PlayerState>(
    'PlayerStateCodec',
    (value): value is PlayerState => PlayerStateFields.is(value),
    (value, context) => {
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
        } as PlayerStateFields;
        migrateMissionCargo(state);
        return t.success(withComputedFreeSpace(state));
    },
    state => PlayerStateFields.encode(state) as PlayerState,
);

export const PlayerStateComponent =
    new Component<PlayerState>('PlayerStateComponent');
export const PlayerStateResource =
    new Resource<PlayerState>('PlayerStateResource');

/**
 * The server-only PlayerStore is provided through this resource without
 * making browser bundles import its Node fs implementation.
 */
export const PlayerStoreResource =
    new Resource<unknown>('PlayerStoreResource');

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
        playerState: PlayerStateCodec,
        ship: EncodedEntity,
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
        cargoCapacity: DEFAULT_CARGO_CAPACITY,
        holds: [],
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

