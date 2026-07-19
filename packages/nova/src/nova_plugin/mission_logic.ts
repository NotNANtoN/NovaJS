import { GovtData } from 'novadatainterface/govt_data';
import { MissionData } from 'novadatainterface/mission_data';
import { PlanetData } from 'novadatainterface/planet_data';
import { evaluateNCBTest, makeControlBitHooks, NCBParseError, NCBSetHooks, runNCBSet } from './ncb.js';
import { Cargo, cargoUsed } from './cargo_plugin.js';
import { ActiveMission, MAX_ACTIVE_MISSIONS, Missions } from './player_state_plugin.js';

/**
 * Pure mission mechanics: availability evaluation, offer resolution
 * (random destinations and cargo quantities are frozen at offer time,
 * as in EV Nova), acceptance, and landing processing (travel legs,
 * completion, deadlines, aborts).
 *
 * Everything here is player-local: it runs while the player's entity
 * is out of the simulation (docked, or in the hands of the jump
 * handoff), so the `random` source may be plain randomness — only the
 * resulting component state reaches the simulation. See
 * mission_board.ts and browser.ts for the wiring.
 */

/** What availability matching needs to know about a stellar. */
export interface StellarInfo {
    id: string;
    /** Global gövt id or null for independent. */
    govt: string | null;
    uninhabited: boolean;
    canLand: boolean;
}

export function stellarInfoOf(planet: PlanetData): StellarInfo {
    return {
        id: planet.id,
        govt: planet.govt,
        uninhabited: planet.flags.uninhabited,
        canLand: planet.flags.canLand && !planet.flags.landOnlyIfDestroyed,
    };
}

/** The numeric resource id of a global id like "nova:130", or null. */
export function numericId(globalId: string | null): number | null {
    if (!globalId) {
        return null;
    }
    const n = parseInt(globalId.split(':').pop() ?? '', 10);
    return Number.isNaN(n) ? null : n;
}

/** The prefix of a global id like "nova:130" ("nova"). */
export function idPrefix(globalId: string): string {
    const colon = globalId.lastIndexOf(':');
    return colon === -1 ? 'nova' : globalId.slice(0, colon);
}

export interface MissionContext {
    /** The stellar the player is landed on. */
    stellar: StellarInfo;
    /** All landable stellars, for resolving random/ranged destinations. */
    stellarCandidates: StellarInfo[];
    /** The player's REAL control bits. */
    bits: Set<number>;
    /** Global id of the player's ship type. */
    shipId: string;
    /** Missions already active (missions can't be offered twice). */
    activeMissions: Missions;
    /** Free cargo space in tons (capacity minus cargo aboard). */
    freeCargoSpace: number;
    /** Uniform [0, 1). Player-local; plain randomness is fine. */
    random(): number;
    /** Synchronous cached govt lookup (warm the cache first). */
    getGovt(id: string): GovtData | undefined;
    /** Current absolute day number (calendar.ts dayNumber). */
    currentDay: number;
}

function intersects(a: number[], b: number[]): boolean {
    return a.some(x => b.includes(x));
}

/**
 * Whether `stellar` matches a mïsn stellar reference (the AvailStel /
 * TravelStel / ReturnStel encoding). `refId` is the parse-time
 * resolved global id for plain ids. The adjacent-system range
 * (5000-7047) is not supported and never matches.
 */
export function matchesStellarRef(ref: number, refId: string | null,
    stellar: StellarInfo, missionPrefix: string,
    getGovt: (id: string) => GovtData | undefined): boolean {
    if (ref === -1) {
        return !stellar.uninhabited;
    }
    if (refId !== null) {
        return stellar.id === refId;
    }
    if (ref === 9999) {
        return stellar.govt === null;
    }
    const stellarGovtId = numericId(stellar.govt);
    const stellarGovt = stellar.govt ? getGovt(stellar.govt) : undefined;

    /** The govt the range is relative to. */
    function rangeGovt(base: number): GovtData | undefined {
        return getGovt(`${missionPrefix}:${ref - base + 128}`);
    }
    function isGovt(base: number): boolean {
        return stellarGovtId === ref - base + 128;
    }
    function classmate(x: GovtData | undefined): boolean {
        if (!x || !stellarGovt) {
            return false;
        }
        return intersects(x.classes, stellarGovt.classes);
    }

    if (ref >= 10000 && ref <= 10255) {
        return isGovt(10000);
    }
    if (ref >= 15000 && ref <= 15255) {
        // The govt's stellar or an ally's.
        const x = rangeGovt(15000);
        return isGovt(15000) || Boolean(x && stellarGovt
            && intersects(x.allies, stellarGovt.classes));
    }
    if (ref >= 20000 && ref <= 20255) {
        return !isGovt(20000);
    }
    if (ref >= 25000 && ref <= 25255) {
        const x = rangeGovt(25000);
        return Boolean(x && stellarGovt
            && intersects(x.enemies, stellarGovt.classes));
    }
    if (ref >= 30000 && ref <= 30255) {
        return isGovt(30000) || classmate(rangeGovt(30000));
    }
    if (ref >= 31000 && ref <= 31255) {
        return !(isGovt(31000) || classmate(rangeGovt(31000)));
    }
    return false;
}

/** Safe NCB test evaluation: malformed expressions fail closed. */
function testBits(expression: string, bits: Set<number>): boolean {
    try {
        return evaluateNCBTest(expression, { getBit: bit => bits.has(bit) });
    } catch (e) {
        if (e instanceof NCBParseError) {
            console.warn('Bad mission NCB test:', e.message);
            return false;
        }
        throw e;
    }
}

/**
 * A concrete offer: the mission with its random choices (destination,
 * cargo) already frozen, ready to show and accept.
 */
export interface MissionOffer {
    data: MissionData;
    travelPlanet: string | null;
    returnPlanet: string | null;
    /** Resolved cargo type (0-255) or -1. */
    cargoType: number;
    cargoQty: number;
    /** Whether Accept may be clicked (cargo fits, mission cap). */
    acceptable: boolean;
    /** Why not, when !acceptable. */
    reason?: string;
}

/** AvailLoc values (see mission_data.ts). */
export const LOCATION_MISSION_COMPUTER = 0;
export const LOCATION_BAR = 1;

/**
 * Whether the mission should appear at this stellar/location for this
 * player, not counting the AvailRandom roll (the caller rolls per
 * landing so re-opening the board doesn't reroll).
 *
 * Known simplifications (documented gaps): AvailRecord is ignored
 * except the domination sentinels (no legal records yet), AvailRating
 * is ignored (no combat rating), Require must be zero (no Contribute
 * bits), and missions with special-ship goals are never offered
 * (combat objectives are unimplemented, so they could never be
 * completed).
 */
export function missionMatchesLocation(mission: MissionData,
    location: number, ctx: MissionContext): boolean {
    if (mission.availLoc !== location) {
        return false;
    }
    if (ctx.activeMissions.has(mission.id)) {
        return false;
    }
    if (!matchesStellarRef(mission.availStel, mission.availStelId,
        ctx.stellar, idPrefix(mission.id), ctx.getGovt)) {
        return false;
    }
    // Domination is not implemented; missions gated on it never show.
    if (mission.availRecord === -32000 || mission.availRecord === -32001) {
        return false;
    }
    // Contribute bits are not implemented; fail closed on Require.
    if (mission.require !== '0') {
        return false;
    }
    // Special-ship goals (destroy/board/escort/...) are unimplemented;
    // offering such a mission would make it impossible to complete.
    if (mission.shipGoal >= 0 && mission.shipCount !== 0
        && mission.shipCount !== -1) {
        return false;
    }
    if (!shipTypeMatches(mission.availShipType, ctx.shipId)) {
        return false;
    }
    if (!testBits(mission.availBits, ctx.bits)) {
        return false;
    }
    return true;
}

function shipTypeMatches(availShipType: number, shipId: string): boolean {
    if (availShipType <= 0) {
        return true;
    }
    const shipNumber = numericId(shipId);
    if (availShipType >= 128 && availShipType <= 255) {
        return shipNumber === availShipType;
    }
    if (availShipType >= 1128 && availShipType <= 1255) {
        return shipNumber !== availShipType - 1000;
    }
    // Ship-govt ranges (2128+/3128+) are not modeled; don't restrict.
    return true;
}

/**
 * Resolves a travel/return stellar reference to a concrete planet id.
 * Returns undefined when the reference cannot be satisfied (which
 * makes the mission unofferable), null for "no destination".
 */
function resolveStellarRef(ref: number, refId: string | null,
    mission: MissionData, ctx: MissionContext,
    forReturn: boolean): string | null | undefined {
    if (ref === -1) {
        return null;
    }
    if (refId !== null) {
        return refId;
    }
    if (forReturn && ref === -4) {
        return ctx.stellar.id;
    }
    let candidates: StellarInfo[];
    if (ref === -2) {
        candidates = ctx.stellarCandidates.filter(
            s => !s.uninhabited && s.canLand);
    } else if (ref === -3) {
        candidates = ctx.stellarCandidates.filter(
            s => s.uninhabited && s.canLand);
    } else {
        candidates = ctx.stellarCandidates.filter(s => s.canLand
            && matchesStellarRef(ref, null, s, idPrefix(mission.id),
                ctx.getGovt));
    }
    // Don't send the player to the planet they're standing on.
    const elsewhere = candidates.filter(s => s.id !== ctx.stellar.id);
    if (elsewhere.length > 0) {
        candidates = elsewhere;
    }
    if (candidates.length === 0) {
        return undefined;
    }
    return candidates[Math.floor(ctx.random() * candidates.length)].id;
}

/** The six standard cargo types (STR# 4001 in stock Nova). */
export const STANDARD_CARGO_NAMES = ['Food', 'Industrial', 'Medical Supplies',
    'Luxury Goods', 'Metal', 'Equipment'];

export function cargoName(cargoType: number): string {
    return STANDARD_CARGO_NAMES[cargoType] ?? `Cargo ${cargoType}`;
}

/** The CargoComponent key that holds a mission's cargo. */
export function missionCargoKey(missionId: string): string {
    return `mission:${missionId}`;
}

/**
 * Builds a concrete offer for a mission that matches this location,
 * freezing random destination and cargo choices. Returns null when a
 * destination cannot be resolved.
 */
export function makeMissionOffer(mission: MissionData,
    ctx: MissionContext): MissionOffer | null {
    const travelPlanet = resolveStellarRef(mission.travelStel,
        mission.travelStelId, mission, ctx, false);
    if (travelPlanet === undefined) {
        return null;
    }
    const returnPlanet = resolveStellarRef(mission.returnStel,
        mission.returnStelId, mission, ctx, true);
    if (returnPlanet === undefined) {
        return null;
    }

    let cargoType = mission.cargoType;
    if (cargoType === 1000) {
        cargoType = Math.floor(ctx.random() * 6);
    }
    let cargoQty = 0;
    if (cargoType >= 0) {
        if (mission.cargoQty >= 0) {
            cargoQty = mission.cargoQty;
        } else if (mission.cargoQty <= -2) {
            // abs(value) tons plus or minus 50%.
            const base = Math.abs(mission.cargoQty);
            cargoQty = Math.max(1,
                Math.round(base / 2 + ctx.random() * base));
        }
    }
    if (cargoQty === 0) {
        cargoType = -1;
    }

    const offer: MissionOffer = {
        data: mission,
        travelPlanet,
        returnPlanet,
        cargoType,
        cargoQty,
        acceptable: true,
    };

    // Cargo picked up at mission start must fit now.
    const loadsNow = cargoQty > 0
        && (mission.pickupMode === 0 || mission.pickupMode === -1);
    if (loadsNow && cargoQty > ctx.freeCargoSpace) {
        if (mission.flags.notOfferedIfInsufficientCargoSpace) {
            return null;
        }
        offer.acceptable = false;
        offer.reason = `You need ${cargoQty} tons of free cargo space `
            + `to accept this mission.`;
    }
    if (ctx.activeMissions.size >= MAX_ACTIVE_MISSIONS) {
        offer.acceptable = false;
        offer.reason = `You cannot take on more than `
            + `${MAX_ACTIVE_MISSIONS} missions at once.`;
    }
    return offer;
}

/** An observable consequence of mission processing, for the UI. */
export interface MissionEvent {
    missionId: string;
    missionName: string;
    type: 'completed' | 'failed' | 'aborted' | 'accepted' | 'autoAborted';
    /** The mission's dësc text for this event ('' if none). */
    text: string;
    /** Credits paid (positive) with this event, if any. */
    payment?: number;
}

/**
 * The player-local mutable state mission processing operates on.
 * These are working copies (the spaceport commit pattern): the caller
 * builds them from the entity's components and commits them back.
 */
export interface MissionWorkingState {
    missions: Missions;
    cargo: Cargo;
    credits: { credits: number };
    bits: Set<number>;
    /** Total cargo capacity in tons (not free space). */
    cargoCapacity: number;
    /** Days the game date should be advanced (DatePostInc), summed. */
    dateAdvance: number;
    events: MissionEvent[];
}

export interface MissionMachineryContext {
    state: MissionWorkingState;
    /** Cached mission data lookup (warm the cache first). */
    getMission(id: string): MissionData | undefined;
    /** Context for resolving Sxxx-started missions' destinations. */
    offerContext(): MissionContext;
    random(): number;
}

function freeCargoSpace(state: MissionWorkingState): number {
    return state.cargoCapacity - cargoUsed(state.cargo);
}

function loadMissionCargo(state: MissionWorkingState,
    active: ActiveMission): boolean {
    if (active.cargoQty <= 0 || active.cargoLoaded) {
        return true;
    }
    if (active.cargoQty > freeCargoSpace(state)) {
        return false;
    }
    state.cargo.set(missionCargoKey(active.id), active.cargoQty);
    active.cargoLoaded = true;
    return true;
}

function unloadMissionCargo(state: MissionWorkingState,
    active: ActiveMission): void {
    state.cargo.delete(missionCargoKey(active.id));
    active.cargoLoaded = false;
}

/**
 * Builds the NCB set hooks for running mission set strings: bit
 * mutation plus the mission operators Sxxx/Axxx/Fxxx wired to the
 * real machinery. `runningMissionPrefix` scopes numeric ids to the
 * plug-in that defined the running expression.
 *
 * Outfit granting (Gxxx/Dxxx) is only wired when the caller supplies
 * an outfits map (the mission board does; landing processing does).
 */
export function makeMissionSetHooks(machinery: MissionMachineryContext,
    runningMissionPrefix: string,
    outfits?: Map<string, number>, depth = 0): NCBSetHooks {
    const { state } = machinery;
    const hooks = makeControlBitHooks(state.bits, outfits ? {
        outfits,
        resolveId: id => `${runningMissionPrefix}:${id}`,
    } : undefined);

    if (depth > 4) {
        // Guard against Sxxx/Axxx/Fxxx cycles in scripting.
        return hooks;
    }

    hooks.startMission = id => {
        startMissionById(machinery,
            `${runningMissionPrefix}:${id}`, outfits, depth + 1);
    };
    hooks.abortMission = id => {
        const globalId = `${runningMissionPrefix}:${id}`;
        if (state.missions.has(globalId)) {
            abortMission(machinery, globalId, outfits, depth + 1);
        }
    };
    hooks.failMission = id => {
        const globalId = `${runningMissionPrefix}:${id}`;
        if (state.missions.has(globalId)) {
            failMission(machinery, globalId, outfits, depth + 1);
        }
    };
    return hooks;
}

export function runMissionSetString(machinery: MissionMachineryContext,
    expression: string, missionPrefix: string,
    outfits?: Map<string, number>, depth = 0): void {
    if (!expression) {
        return;
    }
    try {
        runNCBSet(expression,
            makeMissionSetHooks(machinery, missionPrefix, outfits, depth),
            machinery.random);
    } catch (e) {
        if (e instanceof NCBParseError) {
            console.warn('Bad mission set string:', e.message);
            return;
        }
        throw e;
    }
}

/**
 * Accepts an offer: registers the active mission, loads start-time
 * cargo, runs OnAccept, and handles auto-abort missions (which run
 * their effects and never stay active).
 */
export function acceptOffer(machinery: MissionMachineryContext,
    offer: MissionOffer, outfits?: Map<string, number>, depth = 0): void {
    const { state } = machinery;
    const mission = offer.data;
    const prefix = idPrefix(mission.id);
    const ctx = machinery.offerContext();

    if (mission.flags.autoAbort) {
        // One-shot scripting missions: run OnAccept (and pay if
        // flagged), never becoming active.
        runMissionSetString(machinery, mission.onAccept, prefix,
            outfits, depth);
        let payment: number | undefined;
        if (mission.flags.applyPayOnAutoAbort && mission.payVal > 0) {
            state.credits.credits += mission.payVal;
            payment = mission.payVal;
        }
        state.dateAdvance += Math.max(0, mission.datePostInc);
        state.events.push({
            missionId: mission.id,
            missionName: mission.name,
            type: 'autoAborted',
            text: mission.briefText,
            payment,
        });
        return;
    }

    const active: ActiveMission = {
        id: mission.id,
        acceptedDay: ctx.currentDay,
        acceptedAt: ctx.stellar.id,
        travelPlanet: offer.travelPlanet,
        returnPlanet: offer.returnPlanet,
        cargoType: offer.cargoType,
        cargoQty: offer.cargoQty,
        cargoLoaded: false,
        travelDone: false,
        deadlineDay: mission.timeLimit > 0
            ? ctx.currentDay + mission.timeLimit
            : null,
    };
    state.missions.set(mission.id, active);
    if (offer.cargoQty > 0
        && (mission.pickupMode === 0 || mission.pickupMode === -1)) {
        loadMissionCargo(state, active);
    }
    runMissionSetString(machinery, mission.onAccept, prefix, outfits, depth);
    state.events.push({
        missionId: mission.id,
        missionName: mission.name,
        type: 'accepted',
        text: mission.briefText,
    });
}

/** Refusing an offer just runs OnRefuse. */
export function refuseOffer(machinery: MissionMachineryContext,
    offer: MissionOffer, outfits?: Map<string, number>): void {
    runMissionSetString(machinery, offer.data.onRefuse,
        idPrefix(offer.data.id), outfits);
}

/** Sxxx: start a mission by id, ignoring availability. */
export function startMissionById(machinery: MissionMachineryContext,
    missionId: string, outfits?: Map<string, number>, depth = 0): void {
    const { state } = machinery;
    const mission = machinery.getMission(missionId);
    if (!mission) {
        console.warn(`Sxxx: mission ${missionId} is not loaded; ignoring.`);
        return;
    }
    if (state.missions.has(missionId)
        || state.missions.size >= MAX_ACTIVE_MISSIONS) {
        return;
    }
    const offer = makeMissionOffer(mission, machinery.offerContext());
    if (!offer) {
        console.warn(`Sxxx: could not resolve destinations for ${missionId}.`);
        return;
    }
    acceptOffer(machinery, offer, outfits, depth);
}

/** Axxx / the abort button: run OnAbort, drop cargo, remove. */
export function abortMission(machinery: MissionMachineryContext,
    missionId: string, outfits?: Map<string, number>, depth = 0): void {
    const { state } = machinery;
    const active = state.missions.get(missionId);
    if (!active) {
        return;
    }
    state.missions.delete(missionId);
    unloadMissionCargo(state, active);
    const mission = machinery.getMission(missionId);
    if (mission) {
        runMissionSetString(machinery, mission.onAbort,
            idPrefix(missionId), outfits, depth);
    }
    state.events.push({
        missionId,
        missionName: mission?.name ?? missionId,
        type: 'aborted',
        text: '',
    });
}

/** Fxxx / deadline passed: run OnFailure, drop cargo, remove. */
export function failMission(machinery: MissionMachineryContext,
    missionId: string, outfits?: Map<string, number>, depth = 0): void {
    const { state } = machinery;
    const active = state.missions.get(missionId);
    if (!active) {
        return;
    }
    state.missions.delete(missionId);
    unloadMissionCargo(state, active);
    const mission = machinery.getMission(missionId);
    if (mission) {
        runMissionSetString(machinery, mission.onFailure,
            idPrefix(missionId), outfits, depth);
    }
    state.events.push({
        missionId,
        missionName: mission?.name ?? missionId,
        type: 'failed',
        text: mission?.failText ?? '',
    });
}

function completeMission(machinery: MissionMachineryContext,
    active: ActiveMission, mission: MissionData,
    outfits?: Map<string, number>): void {
    const { state } = machinery;
    state.missions.delete(active.id);
    unloadMissionCargo(state, active);
    let payment: number | undefined;
    // Positive PayVal is credits; the negative encodings (legal-record
    // cleaning, cash removal) are not modeled yet.
    if (mission.payVal > 0) {
        state.credits.credits += mission.payVal;
        payment = mission.payVal;
    }
    state.dateAdvance += Math.max(0, mission.datePostInc);
    runMissionSetString(machinery, mission.onSuccess,
        idPrefix(mission.id), outfits);
    state.events.push({
        missionId: mission.id,
        missionName: mission.name,
        type: 'completed',
        text: mission.completionText,
        payment,
    });
}

/**
 * Processes a landing at `planetId` for every active mission:
 * deadline failures, travel-leg cargo transfer, and completion at the
 * return stellar (paying and running OnSuccess). Events are appended
 * to the working state for the UI.
 */
export function processLanding(machinery: MissionMachineryContext,
    planetId: string, currentDay: number,
    outfits?: Map<string, number>): void {
    const { state } = machinery;
    for (const active of [...state.missions.values()]) {
        const mission = machinery.getMission(active.id);
        if (!mission) {
            console.warn(`Active mission ${active.id} has no data; skipping.`);
            continue;
        }
        if (active.deadlineDay !== null && currentDay > active.deadlineDay) {
            failMission(machinery, active.id, outfits);
            continue;
        }
        if (active.travelPlanet === planetId && !active.travelDone) {
            let transferred = true;
            if (mission.pickupMode === 1) {
                transferred = loadMissionCargo(state, active);
            }
            if (mission.dropOffMode === 0) {
                unloadMissionCargo(state, active);
            }
            if (transferred) {
                active.travelDone = true;
            }
        }
        // A mission with no return stellar completes at its travel
        // stellar; with neither, it can only end by script or abort.
        const completionPlanet = active.returnPlanet ?? active.travelPlanet;
        const travelSatisfied = active.travelPlanet === null
            || active.travelDone;
        if (completionPlanet === planetId && travelSatisfied) {
            completeMission(machinery, active, mission, outfits);
        }
    }
}
