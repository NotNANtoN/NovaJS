import { GovtData } from 'novadatainterface/govt_data';
import { MissionData } from 'novadatainterface/mission_data';
import { PlanetData } from 'novadatainterface/planet_data';
import { DEFAULT_CARGO_NAMES } from 'novadatainterface/player_start_data';
import { evaluateNCBTest, makeControlBitHooks, NCBParseError, NCBSetHooks, runNCBSet } from './ncb.js';
import { Cargo, cargoUsed } from './cargo_plugin.js';
import { resolveShipObjective, shipGoalOfferable } from './mission_ship_logic.js';
import type { SystemInfo } from './mission_ship_logic.js';
import { objectiveAllowsCompletion, ShipObjective } from './mission_ship_state.js';
import { ActiveMission, MAX_ACTIVE_MISSIONS, Missions } from './player_state_plugin.js';
import {
    addRecord,
    AVAIL_RECORD_DOMINATED_ANY,
    AVAIL_RECORD_DOMINATED_HERE,
    availRatingOk,
    availRecordOk,
    cleanRecords,
    compRewardDelta,
    decodePayVal,
    LegalRecords,
    recordWith,
} from './reputation.js';

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
    /**
     * The sÿst Visibility NCB test expressions of every system that
     * contains this stellar (blank = always visible). Absent when the
     * caller has no system topology (bare test stellars, the landed
     * stellar); such stellars are treated as visible. See stellarVisible.
     */
    systemVisibilities?: string[];
}

export function stellarInfoOf(planet: PlanetData): StellarInfo {
    return {
        id: planet.id,
        govt: planet.govt,
        uninhabited: planet.flags.uninhabited,
        canLand: planet.flags.canLand && !planet.flags.landOnlyIfDestroyed,
    };
}

/**
 * Whether a candidate stellar sits in a currently-visible system, per the
 * sÿst Visibility field (EVN Bible, "The Visibility field controls how and
 * when to make the system visible or invisible... an NCB control bit test
 * expression - leave it blank if unused"). Duplicate stellars stacked at
 * one map position use mutually-exclusive Visibility expressions, so only
 * one copy is real at a time; a stellar is visible if ANY of its containing
 * systems is visible. Absent visibility info (bare test stellars) is
 * treated as visible (fail open, so a malformed expression can't empty the
 * candidate pool). Keeps currently-hidden duplicate stellars — e.g. the
 * Federation-govt copy of a Polaris system, or an alternate story-state
 * copy of a planet — out of random/ranged mission-destination sampling.
 */
export function stellarVisible(stellar: StellarInfo,
    bits: Set<number>): boolean {
    const exprs = stellar.systemVisibilities;
    if (!exprs || exprs.length === 0) {
        return true;
    }
    return exprs.some(expr => {
        if (!expr || expr.trim() === '') {
            return true;
        }
        try {
            return evaluateNCBTest(expr, { getBit: bit => bits.has(bit) });
        } catch {
            // A malformed Visibility expression must not hide the galaxy.
            return true;
        }
    });
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
    /**
     * Global gövt id of the player's ship's inherent government, or
     * null/undefined when it has none (or the ship data isn't loaded).
     * Gates the AvailShipType ship-govt ranges (2128+/3128+).
     */
    shipGovt?: string | null;
    /** Missions already active (missions can't be offered twice). */
    activeMissions: Missions;
    /** Free cargo space in tons (capacity minus cargo aboard). */
    freeCargoSpace: number;
    /** The player's legal records (AvailRecord); absent = no records. */
    records?: LegalRecords;
    /** The player's combat-rating kill points (AvailRating). */
    combatRating?: number;
    /**
     * The player's combined 64-bit Contribute mask (ship + outfits),
     * checked against the mïsn Require field. Absent = 0n (only a
     * zero Require passes).
     */
    playerContribute?: bigint;
    /** Uniform [0, 1). Player-local; plain randomness is fine. */
    random(): number;
    /** Synchronous cached govt lookup (warm the cache first). */
    getGovt(id: string): GovtData | undefined;
    /** Current absolute day number (calendar.ts dayNumber). */
    currentDay: number;
    /**
     * All systems, for resolving special/aux ship spawn systems
     * (mission_ship_logic.ts). Optional: callers that don't supply it
     * keep ship-goal missions unofferable (fail closed).
     */
    systems?: SystemInfo[];
    /** Maps a planet id to its containing system id. */
    systemIdOfStellar?(planetId: string): string | undefined;
}

function intersects(a: number[], b: number[]): boolean {
    return a.some(x => b.includes(x));
}

/**
 * Whether the player's Contribute mask covers a mïsn/oütf Require field
 * (a decimal or hex 64-bit string). Every 1-bit in Require must be set
 * in `contribute`. A '0' (or malformed) require is always satisfied.
 */
function requireMet(require: string, contribute: bigint): boolean {
    let mask: bigint;
    try {
        mask = BigInt(require);
    } catch {
        return true;
    }
    return (mask & contribute) === mask;
}

/**
 * Resolves whether a stellar sits in a target system or one adjacent to
 * it, for the AvailStel 5000-7047 range. Supplied by callers that have
 * system topology (the mission board / landing); callers without it
 * (e.g. the travel/return resolution, where the Bible does not define
 * 5000-7047) omit it and the range never matches.
 */
export interface StellarAdjacency {
    /** The global system id containing `stellarId`, or undefined. */
    systemOfStellar(stellarId: string): string | undefined;
    /** Whether system `a` is the same as or hyperlinked to system `b`. */
    systemsAdjacentOrEqual(a: string, b: string): boolean;
}

/**
 * Whether `stellar` matches a mïsn stellar reference (the AvailStel /
 * TravelStel / ReturnStel encoding). `refId` is the parse-time
 * resolved global id for plain ids. The adjacent-system range
 * (5000-7047, AvailStel only per the Bible) is matched only when the
 * caller supplies `adjacency`; otherwise it never matches.
 */
export function matchesStellarRef(ref: number, refId: string | null,
    stellar: StellarInfo, missionPrefix: string,
    getGovt: (id: string) => GovtData | undefined,
    adjacency?: StellarAdjacency): boolean {
    if (ref === -1) {
        return !stellar.uninhabited;
    }
    if (refId !== null) {
        return stellar.id === refId;
    }
    // AvailStel 5000-7047: "Stellar in a system adjacent to specific
    // system" (the range indexes system ids 128-2175 by 5000 + (id -
    // 128)). Matches the target system itself as well as its neighbors.
    if (ref >= 5000 && ref <= 7047) {
        if (!adjacency) {
            return false;
        }
        const targetSystem = `${missionPrefix}:${ref - 5000 + 128}`;
        const stellarSystem = adjacency.systemOfStellar(stellar.id);
        return stellarSystem !== undefined
            && adjacency.systemsAdjacentOrEqual(stellarSystem, targetSystem);
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

/**
 * Builds the StellarAdjacency for AvailStel 5000-7047 from a mission
 * context's system topology. Returns undefined when the caller didn't
 * supply systems (the range then never matches — fail closed).
 */
export function stellarAdjacencyOf(ctx: MissionContext):
    StellarAdjacency | undefined {
    const { systems, systemIdOfStellar } = ctx;
    if (!systems || !systemIdOfStellar) {
        return undefined;
    }
    const linksById = new Map(systems.map(s => [s.id, s.links]));
    return {
        systemOfStellar: id => systemIdOfStellar(id),
        systemsAdjacentOrEqual: (a, b) =>
            a === b || (linksById.get(a)?.includes(b) ?? false),
    };
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
    /** Frozen special-ship objective; absent without special ships. */
    shipObjective?: ShipObjective;
    /** Whether Accept may be clicked (cargo fits, mission cap). */
    acceptable: boolean;
    /** Why not, when !acceptable. */
    reason?: string;
}

/**
 * AvailLoc values — where on a stellar a mission is offered (EVN Bible,
 * "AvailLoc"): 0 mission computer, 1 bar, 2 offered from a ship (përs),
 * 3 the main spaceport dialog (offered on landing), 4 trading, 5
 * shipyard, 6 outfitter. See mission_data.ts.
 */
export const LOCATION_MISSION_COMPUTER = 0;
export const LOCATION_BAR = 1;
export const LOCATION_SHIP = 2;
export const LOCATION_MAIN_SPACEPORT = 3;
export const LOCATION_TRADING = 4;
export const LOCATION_SHIPYARD = 5;
export const LOCATION_OUTFIT = 6;

/**
 * Whether the mission should appear at this stellar/location for this
 * player, not counting the AvailRandom roll (the caller rolls per
 * landing so re-opening the board doesn't reroll).
 *
 * Known simplifications (documented gaps): Require must be zero (no
 * Contribute bits), and missions with board/rescue ship goals are
 * never offered (boarding is unimplemented, so they could never be
 * completed; see mission_ship_logic.ts).
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
        ctx.stellar, idPrefix(mission.id), ctx.getGovt,
        stellarAdjacencyOf(ctx))) {
        return false;
    }
    // Domination is not implemented; missions gated on it never show.
    if (mission.availRecord === AVAIL_RECORD_DOMINATED_HERE
        || mission.availRecord === AVAIL_RECORD_DOMINATED_ANY) {
        return false;
    }
    // AvailRecord: the record with this stellar's govt (independent
    // stellars judge by govt 128, per the Bible's Appendix II rule for
    // independent systems).
    if (!availRecordOk(mission.availRecord,
        stellarRecord(ctx.stellar, ctx.records ?? new Map(),
            idPrefix(mission.id), ctx.getGovt))) {
        return false;
    }
    if (!availRatingOk(mission.availRating, ctx.combatRating ?? 0)) {
        return false;
    }
    // Require: every 1-bit must be covered by the player's Contribute
    // mask (ship + outfits). Absent contribute means only require '0'
    // (no requirement) passes.
    if (!requireMet(mission.require, ctx.playerContribute ?? 0n)) {
        return false;
    }
    // Board/rescue ship goals need boarding, which is unimplemented;
    // offering such a mission would make it impossible to complete.
    if (!shipGoalOfferable(mission)) {
        return false;
    }
    if (!shipTypeMatches(mission.availShipType, ctx.shipId, ctx.shipGovt)) {
        return false;
    }
    if (!testBits(mission.availBits, ctx.bits)) {
        return false;
    }
    return true;
}

/**
 * The player's legal record at a stellar: the record with its govt,
 * or — for an independent stellar — with govt 128, the Bible's rule
 * for independent systems (Appendix II).
 */
export function stellarRecord(stellar: StellarInfo, records: LegalRecords,
    missionPrefix: string,
    getGovt: (id: string) => GovtData | undefined): number {
    const govtId = stellar.govt ?? `${missionPrefix}:128`;
    return recordWith(records, govtId, getGovt(govtId));
}

/**
 * Whether the player's ship satisfies a mïsn AvailShipType. The Bible's
 * ranges: 0/-1 ignored; 128-895 must be this ship type; 1128-1895 must
 * not be; 2128-2383 must be a ship of this inherent gövt; 3128-3383
 * must not be. `shipGovt` is the global id of the player's ship's
 * inherent gövt (null when it has none).
 */
function shipTypeMatches(availShipType: number, shipId: string,
    shipGovt: string | null | undefined): boolean {
    if (availShipType <= 0) {
        return true;
    }
    const shipNumber = numericId(shipId);
    if (availShipType >= 128 && availShipType <= 895) {
        return shipNumber === availShipType;
    }
    if (availShipType >= 1128 && availShipType <= 1895) {
        return shipNumber !== availShipType - 1000;
    }
    // Ship-govt ranges: the govt id is the range offset (2000 / 3000).
    if (availShipType >= 2128 && availShipType <= 2383) {
        return numericId(shipGovt ?? null) === availShipType - 2000;
    }
    if (availShipType >= 3128 && availShipType <= 3383) {
        return numericId(shipGovt ?? null) !== availShipType - 3000;
    }
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
    // Random / govt-ranged destinations sample only currently-VISIBLE
    // stellars: a hidden duplicate (e.g. an alternate-story-state copy of
    // a planet, stacked at the same coordinates under a mutually-exclusive
    // Visibility bit) must never be frozen as a destination — the player
    // would land on the visible copy under a different id and the mission
    // could never complete. Specific-id destinations (refId !== null) are
    // authored deliberately and are left unfiltered.
    let candidates: StellarInfo[];
    if (ref === -2) {
        candidates = ctx.stellarCandidates.filter(
            s => !s.uninhabited && s.canLand && stellarVisible(s, ctx.bits));
    } else if (ref === -3) {
        candidates = ctx.stellarCandidates.filter(
            s => s.uninhabited && s.canLand && stellarVisible(s, ctx.bits));
    } else {
        candidates = ctx.stellarCandidates.filter(s => s.canLand
            && stellarVisible(s, ctx.bits)
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

/**
 * The standard cargo names (STR# 4000 in stock Nova). Kept as a
 * fallback for the built-in six commodities; the live names come from
 * the parsed PlayerStartData.cargoNames (DEFAULT_CARGO_NAMES).
 */
export const STANDARD_CARGO_NAMES = [...DEFAULT_CARGO_NAMES];

/**
 * The display name for a cargo type, resolved from the scenario's
 * parsed STR# 4000 names when supplied, else the built-in fallback.
 */
export function cargoName(cargoType: number,
    names: readonly string[] = STANDARD_CARGO_NAMES): string {
    return names[cargoType] || STANDARD_CARGO_NAMES[cargoType]
        || `Cargo ${cargoType}`;
}

/** The CargoComponent key that holds a mission's cargo. */
export function missionCargoKey(missionId: string): string {
    return `mission:${missionId}`;
}

/**
 * A system to mark on the starmap for an active mission.
 *  - 'destination': a travel or return stellar's system (the original's
 *    red destination arrows), suppressed by the mïsn hideDestArrows flag.
 *  - 'shipSyst': the special-ship spawn system, marked only when the
 *    mïsn showArrowForShipSyst flag is set (the additional arrow).
 */
export interface MissionMapMark {
    systemId: string;
    kind: 'destination' | 'shipSyst';
    missionId: string;
}

/**
 * The systems to mark on the starmap for the player's active missions,
 * per the mïsn map flags. Pure: `systemOfStellar` maps a planet id to
 * its system id (undefined = unplaced), `getMission` fetches the static
 * mission data (undefined = not loaded). Destination marks come from the
 * travel/return stellars unless hideDestArrows is set; a ship-goal
 * system is marked only under showArrowForShipSyst. Deduplicated per
 * (system, kind, mission).
 */
export function missionMapMarks(missions: Iterable<ActiveMission>,
    getMission: (id: string) => MissionData | undefined,
    systemOfStellar: (planetId: string) => string | undefined):
    MissionMapMark[] {
    const marks: MissionMapMark[] = [];
    const seen = new Set<string>();
    const add = (systemId: string | undefined,
        kind: MissionMapMark['kind'], missionId: string) => {
        if (!systemId) {
            return;
        }
        const key = `${systemId}|${kind}|${missionId}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        marks.push({ systemId, kind, missionId });
    };
    for (const active of missions) {
        const mission = getMission(active.id);
        if (!mission) {
            continue;
        }
        if (!mission.flags.hideDestArrows) {
            if (active.travelPlanet) {
                add(systemOfStellar(active.travelPlanet),
                    'destination', active.id);
            }
            if (active.returnPlanet) {
                add(systemOfStellar(active.returnPlanet),
                    'destination', active.id);
            }
        }
        if (mission.flags.showArrowForShipSyst
            && active.shipObjective?.systemId) {
            add(active.shipObjective.systemId, 'shipSyst', active.id);
        }
    }
    return marks;
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
    // Special ships: freeze the spawn system and goal state. null
    // means unresolvable (or an unsupported goal): unofferable.
    const shipObjective = resolveShipObjective(mission, ctx,
        travelPlanet, returnPlanet);
    if (shipObjective === null) {
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
        shipObjective,
        acceptable: true,
    };

    // Cargo picked up at mission start must fit now.
    const loadsNow = cargoQty > 0
        && (mission.pickupMode === 0 || mission.pickupMode === -1);
    if (loadsNow && cargoQty > ctx.freeCargoSpace
        && mission.flags.notOfferedIfInsufficientCargoSpace) {
        return null;
    }
    const check = checkAcceptable(offer, ctx);
    if (!check.acceptable) {
        offer.acceptable = false;
        offer.reason = check.reason;
    }
    return offer;
}

/**
 * Re-evaluates whether an offer can be accepted against the CURRENT
 * context (cargo already committed by other accepted missions, current
 * active-mission count). `makeMissionOffer` freezes `acceptable` at
 * board-open; this is called again at accept time so a second cargo
 * mission can't slip past a now-full hold, and the 16-mission cap can't
 * be exceeded by a stale offer (L3/L4).
 */
export function checkAcceptable(offer: MissionOffer, ctx: MissionContext):
    { acceptable: true } | { acceptable: false; reason: string } {
    const mission = offer.data;
    // Cargo picked up at mission start must fit now.
    const loadsNow = offer.cargoQty > 0
        && (mission.pickupMode === 0 || mission.pickupMode === -1);
    if (loadsNow && offer.cargoQty > ctx.freeCargoSpace) {
        return {
            acceptable: false,
            reason: `You need ${offer.cargoQty} tons of free cargo space `
                + `to accept this mission.`,
        };
    }
    if (ctx.activeMissions.size >= MAX_ACTIVE_MISSIONS) {
        return {
            acceptable: false,
            reason: `You cannot take on more than `
                + `${MAX_ACTIVE_MISSIONS} missions at once.`,
        };
    }
    return { acceptable: true };
}

/** An observable consequence of mission processing, for the UI. */
export interface MissionEvent {
    missionId: string;
    missionName: string;
    type: 'completed' | 'failed' | 'aborted' | 'accepted' | 'autoAborted'
        | 'shipDone' | 'cargoLoaded' | 'cargoDropped';
    /** The mission's dësc text for this event ('' if none). */
    text: string;
    /**
     * The global PICT id of the dësc Graphic paired with `text`, shown
     * beside it in the result popup (completion/fail/shipDone), or absent
     * when that dësc has no graphic. Already a resolved global id from the
     * misn parser (misn_parse.ts descGraphic), so it needs no prefixing.
     */
    pict?: string | null;
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
    /**
     * The player's legal records, for CompReward and the PayVal
     * record-cleaning encodings. Optional so bare test states keep
     * working; reputation effects are skipped when absent.
     */
    records?: LegalRecords;
}

export interface MissionMachineryContext {
    state: MissionWorkingState;
    /** Cached mission data lookup (warm the cache first). */
    getMission(id: string): MissionData | undefined;
    /** Context for resolving Sxxx-started missions' destinations. */
    offerContext(): MissionContext;
    random(): number;
    /**
     * Every govt (deterministic order), for ally/classmate scopes of
     * the PayVal record-cleaning encodings. Optional; cleaning
     * degrades to the named govt only when absent.
     */
    allGovts?(): Iterable<readonly [string, GovtData]>;
    /**
     * Whether two stellar ids denote the "same stellar" — identical name
     * and map coordinates — so landing on one fulfils a travel/return
     * objective set to the other (EVN Bible, TravelStel/ReturnStel: "the
     * mission travel objectives will also be fulfilled when landing on a
     * duplicate stellar that has the idendical name and coordinates to the
     * stellar you specify here"). Optional; without it only exact-id
     * matches complete a landing.
     */
    sameStellar?(a: string, b: string): boolean;
}

/**
 * Applies a mission outcome's CompGovt/CompReward record change
 * (Bible: complete grants CompReward; failure costs half — "that govt
 * will take it personally"; abort costs 5x under mïsn flag 0x0040).
 */
function applyOutcomeReputation(machinery: MissionMachineryContext,
    mission: MissionData, outcome: 'complete' | 'fail' | 'abort'): void {
    const { state } = machinery;
    if (!state.records || mission.compGovt < 128) {
        return;
    }
    const delta = compRewardDelta(mission.compReward, outcome,
        mission.flags.lose5xCompRewardOnAbort);
    if (delta === 0) {
        return;
    }
    const govtId = `${idPrefix(mission.id)}:${mission.compGovt}`;
    addRecord(state.records, govtId,
        machinery.offerContext().getGovt(govtId), delta);
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

/** The result of an accept attempt (see acceptOffer). */
export type AcceptResult =
    | { accepted: true }
    | { accepted: false; reason: string };

/**
 * Accepts an offer: registers the active mission, loads start-time
 * cargo, runs OnAccept, and handles auto-abort missions (which run
 * their effects and never stay active).
 *
 * The offer's `acceptable` flag is frozen at board-open; a normal
 * (staying) mission is re-checked against the CURRENT context here so a
 * stale offer can't slip cargo past a hold another accepted mission has
 * since filled, or exceed the 16-mission cap (L3/L4). When the re-check
 * fails, nothing is committed and the reason is returned for the UI.
 * `skipAcceptabilityCheck` is for scripted starts (Sxxx), which ignore
 * availability by contract and gate the cap themselves.
 */
export function acceptOffer(machinery: MissionMachineryContext,
    offer: MissionOffer, outfits?: Map<string, number>, depth = 0,
    skipAcceptabilityCheck = false): AcceptResult {
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
            // The autoAborted popup shows briefText, so pair it with the
            // briefing dësc's graphic (not failPict) to keep the picture
            // consistent with the text beside it.
            pict: mission.briefPict,
            payment,
        });
        return { accepted: true };
    }

    // Re-evaluate cargo fit + the mission cap against current state: the
    // frozen offer may no longer be acceptable.
    if (!skipAcceptabilityCheck) {
        const check = checkAcceptable(offer, ctx);
        if (!check.acceptable) {
            return { accepted: false, reason: check.reason };
        }
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
        // Frozen so the shared sim can fail the mission on a player
        // disable/destroy without reading mission game data.
        failIfPlayerDisabledOrDestroyed:
            mission.flags.failIfPlayerDisabledOrDestroyed,
        // Copied (not aliased) so re-showing the offer stays pristine.
        shipObjective: offer.shipObjective && {
            ...offer.shipObjective,
            live: new Map(offer.shipObjective.live),
        },
    };
    state.missions.set(mission.id, active);
    if (offer.cargoQty > 0
        && (mission.pickupMode === 0 || mission.pickupMode === -1)) {
        loadMissionCargo(state, active);
    }
    // PayVal -50000 and down: take credits at mission START (the only
    // PayVal encoding that applies before completion). Clamped at 0 —
    // EV Nova has no debt.
    const pay = decodePayVal(mission.payVal);
    if (pay.type === 'takeCredits') {
        state.credits.credits = Math.max(0,
            state.credits.credits - pay.amount);
    }
    runMissionSetString(machinery, mission.onAccept, prefix, outfits, depth);
    state.events.push({
        missionId: mission.id,
        missionName: mission.name,
        type: 'accepted',
        text: mission.briefText,
    });
    return { accepted: true };
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
    // Scripted starts ignore availability (cargo fit): the cap is gated
    // above. Skip the accept-time re-check so a full hold can't silently
    // block a story mission the way it blocks a board accept.
    acceptOffer(machinery, offer, outfits, depth, true);
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
        applyOutcomeReputation(machinery, mission, 'abort');
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
        applyOutcomeReputation(machinery, mission, 'fail');
        runMissionSetString(machinery, mission.onFailure,
            idPrefix(missionId), outfits, depth);
    }
    state.events.push({
        missionId,
        missionName: mission?.name ?? missionId,
        type: 'failed',
        text: mission?.failText ?? '',
        pict: mission?.failPict ?? null,
    });
}

function completeMission(machinery: MissionMachineryContext,
    active: ActiveMission, mission: MissionData,
    outfits?: Map<string, number>): void {
    const { state } = machinery;
    state.missions.delete(active.id);
    unloadMissionCargo(state, active);
    let payment: number | undefined;
    // PayVal: credits, record cleaning, or cash removal (the Bible's
    // negative encodings; takeCredits already applied at accept).
    const pay = decodePayVal(mission.payVal);
    if (pay.type === 'credits') {
        state.credits.credits += pay.amount;
        payment = pay.amount;
    } else if (pay.type === 'takePercent') {
        state.credits.credits -= Math.trunc(
            state.credits.credits * pay.percent / 100);
    } else if (pay.type === 'cleanRecord' && state.records) {
        const govtId = `${idPrefix(mission.id)}:${pay.govtResourceId}`;
        cleanRecords(state.records, pay.scope,
            machinery.offerContext().getGovt(govtId),
            machinery.allGovts?.() ?? []);
    }
    applyOutcomeReputation(machinery, mission, 'complete');
    state.dateAdvance += Math.max(0, mission.datePostInc);
    runMissionSetString(machinery, mission.onSuccess,
        idPrefix(mission.id), outfits);
    state.events.push({
        missionId: mission.id,
        missionName: mission.name,
        type: 'completed',
        text: mission.completionText,
        pict: mission.completionPict,
        payment,
    });
}

/**
 * Runs a mission's OnShipDone (and queues its ShipDoneText event) if the
 * shared sim flagged its ship goal complete (shipDonePending). The Bible
 * runs OnShipDone the moment the goal completes; the set string mutates
 * control bits player-locally, so the earliest deterministic, owner-
 * driven point is the next date advance (jump or landing). Clears the
 * pending flag so it runs exactly once.
 */
function runShipDoneIfPending(machinery: MissionMachineryContext,
    active: ActiveMission, mission: MissionData,
    outfits?: Map<string, number>): void {
    const objective = active.shipObjective;
    if (!objective?.shipDonePending) {
        return;
    }
    objective.shipDonePending = false;
    runMissionSetString(machinery, mission.onShipDone,
        idPrefix(mission.id), outfits);
    if (mission.shipDoneText) {
        machinery.state.events.push({
            missionId: mission.id,
            missionName: mission.name,
            type: 'shipDone',
            text: mission.shipDoneText,
            pict: mission.shipDonePict,
        });
    }
}

/**
 * Runs OnShipDone for every active mission whose ship goal just
 * completed (shipDonePending), appending any ShipDoneText events.
 * Called at each date advance (jump or landing) so OnShipDone fires at
 * the first player-local opportunity after the goal completes rather
 * than waiting for a landing. Returns how many ran.
 */
export function runPendingShipDone(machinery: MissionMachineryContext,
    outfits?: Map<string, number>): number {
    const { state } = machinery;
    let ran = 0;
    for (const active of [...state.missions.values()]) {
        // The loop iterates a snapshot; an earlier mission's OnShipDone
        // can abort/fail a later one via an Axxx/Fxxx set string, removing
        // it from state.missions mid-loop (abort/fail leave shipDonePending
        // untouched). Skip any mission that is no longer active so a dead
        // mission's OnShipDone (and shipDone event) never runs, mirroring
        // the guard failExpiredMissions gets for free from failMission's
        // early return. See mission_logic_test.ts (self/sibling abort).
        if (!state.missions.has(active.id)) {
            continue;
        }
        if (!active.shipObjective?.shipDonePending) {
            continue;
        }
        const mission = machinery.getMission(active.id);
        if (!mission) {
            continue;
        }
        runShipDoneIfPending(machinery, active, mission, outfits);
        ran++;
    }
    return ran;
}

/**
 * Fails every active mission whose deadline has passed as of
 * `currentDay`, or which the shared sim marked failed (`active.failed`).
 * Runs OnFailure and appends a failure event for each — the same as a
 * landing-time deadline failure, but callable at every date advance
 * (jump or landing) so a deadline that expires in flight fails the
 * moment it passes rather than at the next landing. Returns the number
 * of missions failed. Missions completing at their destination are left
 * to processLanding.
 */
export function failExpiredMissions(machinery: MissionMachineryContext,
    currentDay: number, outfits?: Map<string, number>): number {
    const { state } = machinery;
    let failed = 0;
    for (const active of [...state.missions.values()]) {
        const expired = active.deadlineDay !== null
            && currentDay > active.deadlineDay;
        if (expired || active.failed) {
            failMission(machinery, active.id, outfits);
            failed++;
        }
    }
    return failed;
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
    // Landing at `planetId` also satisfies an objective set to a duplicate
    // stellar (same name + coordinates), per the Bible. Threaded via
    // sameStellar so pure callers without topology keep exact-id matching.
    const landedAt = (destId: string | null): boolean =>
        destId !== null && (destId === planetId
            || (machinery.sameStellar?.(destId, planetId) ?? false));
    for (const active of [...state.missions.values()]) {
        // The loop iterates a snapshot; an earlier mission's OnSuccess (or
        // OnShipDone/OnAbort) can abort/fail/complete a later one via an
        // Axxx/Fxxx set string, removing it from state.missions mid-loop.
        // Skip any mission that is no longer active so we never re-process
        // (and re-pay) it.
        if (!state.missions.has(active.id)) {
            continue;
        }
        const mission = machinery.getMission(active.id);
        if (!mission) {
            console.warn(`Active mission ${active.id} has no data; skipping.`);
            continue;
        }
        if (active.deadlineDay !== null && currentDay > active.deadlineDay) {
            failMission(machinery, active.id, outfits);
            continue;
        }
        if (active.failed) {
            // The shared sim marked the mission failed (the owner was
            // disabled or destroyed under Flags2 0x0004).
            failMission(machinery, active.id, outfits);
            continue;
        }
        const objective = active.shipObjective;
        if (objective?.failed) {
            // The ship goal became unachievable (an escort died, a
            // disable target was destroyed).
            failMission(machinery, active.id, outfits);
            continue;
        }
        // OnShipDone normally runs at the previous date advance (jump or
        // landing) the moment the goal completed; this catches the case
        // where the goal completed at this very landing's date advance.
        runShipDoneIfPending(machinery, active, mission, outfits);
        // OnShipDone's set string can abort/fail THIS mission (an Axxx/Fxxx
        // naming itself, which the abort/fail hooks allow since it is still
        // active at that point). Re-check membership before falling through
        // to completion so a self-aborted mission isn't also completed —
        // which would pay PayVal and push a 'completed' event for a mission
        // that was just aborted. See mission_logic_test.ts (self-abort).
        if (!state.missions.has(active.id)) {
            continue;
        }
        if (landedAt(active.travelPlanet) && !active.travelDone) {
            let transferred = true;
            if (mission.pickupMode === 1) {
                transferred = loadMissionCargo(state, active);
                if (transferred && mission.loadCargoText) {
                    // The LoadCargText dësc, as a landing popup — without
                    // it, picking up the cargo is silent and the player
                    // can't tell the stop registered.
                    state.events.push({
                        missionId: mission.id,
                        missionName: mission.name,
                        type: 'cargoLoaded',
                        text: mission.loadCargoText,
                        pict: mission.loadCargoPict,
                    });
                }
            }
            if (mission.dropOffMode === 0) {
                unloadMissionCargo(state, active);
                if (mission.dropOffCargoText) {
                    // The DropCargText dësc (e.g. the Kontik probe's desc
                    // 8781) — the original shows it when the cargo is
                    // dropped at the travel stellar; landing "silently
                    // working" reads as the mission being stuck.
                    state.events.push({
                        missionId: mission.id,
                        missionName: mission.name,
                        type: 'cargoDropped',
                        text: mission.dropOffCargoText,
                        pict: mission.dropOffCargoPict,
                    });
                }
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
        const goalSatisfied = !objective
            || objectiveAllowsCompletion(objective);
        if (landedAt(completionPlanet) && travelSatisfied
            && goalSatisfied) {
            completeMission(machinery, active, mission, outfits);
        }
    }
}
