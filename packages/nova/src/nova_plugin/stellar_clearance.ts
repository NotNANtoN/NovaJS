import { GovtData } from 'novadatainterface/govt_data';
import { PlanetData } from 'novadatainterface/planet_data';
import { LegalRecords, recordWith } from './reputation.js';

/**
 * ============================================================================
 * Landing clearance — the ONE predicate (EVN Bible, spöb MinStatus + gövt
 * Require)
 * ============================================================================
 *
 * Whether a stellar will let THIS player land, and — when it won't — WHY.
 * Quoted by the landing gate (planet_plugin's AttemptLandingSystem), the
 * radar's planet blip colour (iff_plugin's planetDisposition), the planet
 * comm dialog (hail_dialog_plugin), and the sim's planet-bribe handler
 * (hail_plugin's applyHail), so those four can never disagree about whether
 * a port is open — the same arrangement `landable` uses for "is it a port at
 * all" and `shipDisposition` uses for ship hostility.
 *
 * Pure and total over synced state (spöb data, the player's legal records,
 * the player's Contribute bits, the bribe map), with no clock read and no
 * randomness, so the display and the simulation reach the same verdict on
 * every peer.
 *
 * THE RULES, verbatim from the Bible:
 *
 *  - spöb **MinStatus** (~:2785): "The point on your record in the current
 *    system that you'll be denied landing clearance on this stellar."
 *      -32767         "Ignored (player can always land)"
 *      -1 to -32766   "You can be this evil before they shun you"
 *       0 to 32766    "They have to like you this much before they let you
 *                      land"
 *       32767         "Player can never land."
 *      "(Note that this field is ignored if the stellar is uninhabited)"
 *
 *    So the test is simply `record < minStatus` for every value in between,
 *    with the two sentinels short-circuiting it.
 *
 *  - gövt **Require** (~:1121): "These two Require fields together form a
 *    64-bit flag that is logically and'ed with the Contribute fields from the
 *    player's current ship and outfit items. If for each 1 bit in the Require
 *    fields there is not a matching 1 bit in one or more of the Contribute
 *    fields then you won't be allowed to visit any planets or stations owned
 *    by this govt - this is useful for making travel permits, for example."
 *    That is a SECOND, independent denial reason ('permit'), evaluated with
 *    the same mask arithmetic the shipyard and outfitter already use
 *    (shipyard_stock_rules' shipRequirementsMet).
 *
 * "YOUR RECORD IN THE CURRENT SYSTEM": the original keys legal records by
 * SYSTEM, seeded from the system owner's InitialRec. NovaJS keys them by
 * GOVERNMENT (reputation.ts's sanctioned simplification), so the record a
 * stellar judges you on is your record with the stellar's OWNING govt — which
 * for a stock system is the same number the original would have used, because
 * a stock system's stellars belong to the government that owns the system.
 * An INDEPENDENT stellar (spöb Govt -1, `govt: null`) has no government to
 * hold a record with and reads as 0.
 *
 * TWO EXEMPTIONS, both from the data rather than from taste:
 *
 *  1. UNINHABITED stellars (spöb Flags 0x0020) — the Bible's own parenthesis.
 *     There is no traffic control to deny you.
 *
 *  2. HYPERGATES AND WORMHOLES. All 19 stock spöbs carrying MinStatus 32767
 *     ("Player can never land") are working hypergates — HG-V01 through
 *     HG-Koria, every one of them gövt nova:183 with the can-land bit SET and
 *     live HyperLink destinations. They are not shut ports; the field is
 *     saying "you never LAND on a gate", and the engine's gate ENTRY is a
 *     different operation from a landing-clearance request. Honouring 32767
 *     literally here would break the entire working hypergate network, so a
 *     stellar with a `gate` is cleared without consulting MinStatus at all.
 *     (There is consequently NO stock spöb that is 'forbidden' — see the
 *     report; military-base style bases were expected but the stock data has
 *     none. The 'forbidden' path exists for plug-ins and for the govt Require
 *     permits.)
 *
 * NCB-gated landing denial (the mïsn/spöb bit tests behind some of the
 * original's refusals) remains the separate, unbuilt seam landable.ts names.
 */

/** MinStatus sentinel: "Ignored (player can always land)". */
export const MIN_STATUS_IGNORED = -32767;
/** MinStatus sentinel: "Player can never land." */
export const MIN_STATUS_NEVER = 32767;

/**
 * Why a stellar refuses landing clearance.
 *
 *  - 'forbidden': the port is shut to everyone (MinStatus 32767), or the
 *    player lacks the owning govt's travel permit ('permit' folds in here for
 *    colouring — see iff_plugin's planetDisposition). The original's word for
 *    this state is "Forbidden" (STR# 2002 index 172).
 *  - 'hostile': the player's legal record is below the stellar's MinStatus —
 *    they know you and they don't like you. The original's word is "Hostile"
 *    (STR# 2002 index 173).
 *  - 'permit': the gövt Require / Contribute travel-permit test failed.
 */
export type ClearanceDenial = 'forbidden' | 'hostile' | 'permit';

export type StellarClearance =
    | { cleared: true }
    | { cleared: false, reason: ClearanceDenial };

const CLEARED: StellarClearance = { cleared: true };

/** The static half of a clearance decision: what the spöb itself says. */
export interface ClearanceStellar {
    minStatus: number;
    flags: { uninhabited: boolean };
    /** Non-null for a hypergate/wormhole (PlanetData.gate). */
    gate: unknown | null;
}

/** The player half: who they are to this stellar right now. */
export interface ClearancePlayer {
    /** The player's legal record with the stellar's owning govt. */
    record: number;
    /**
     * The owning gövt's 64-bit Require mask (GovtData.require, a DECIMAL
     * string — unlike shïp/oütf Contribute, which are hex). Undefined for an
     * independent stellar.
     */
    govtRequire?: string;
    /** Union of the player's ship + outfit Contribute bits. */
    contribute?: bigint;
    /** True while a paid bribe is buying this player clearance here. */
    bribed?: boolean;
}

/**
 * The union of the Contribute flag sets of the player's current ship and every
 * outfit it carries — the left-hand side of the gövt Require test. The
 * spaceport has its own copy of this (shipyard_stock_rules' playerContribute)
 * built from a resolved id->contribute map; this one takes the raw values so
 * the SIMULATION can compute it from OutfitsStateComponent + cached outfit data
 * without importing the spaceport layer. shïp/oütf Contribute are hex strings.
 */
export function contributeBits(shipContribute: string | undefined,
    outfitContributes: Iterable<string | undefined>): bigint {
    let contribute = BigInt(shipContribute ?? '0x0');
    for (const value of outfitContributes) {
        contribute |= BigInt(value ?? '0x0');
    }
    return contribute;
}

/**
 * Whether the player's Contribute set covers a govt's Require mask. An empty
 * Require (0) always passes. Mirrors shipyard_stock_rules' shipRequirementsMet
 * but parses the govt's DECIMAL encoding — `BigInt` handles both forms, so the
 * only real difference is the default.
 */
export function govtRequirementsMet(require: string | undefined,
    contribute: bigint | undefined): boolean {
    const mask = BigInt(require ?? '0');
    return (mask & (contribute ?? 0n)) === mask;
}

/**
 * Whether `stellar` grants `player` landing clearance, and why not. See the
 * module comment for the rules and the two exemptions.
 *
 * Order matters only for WHICH reason a denied stellar reports (the landing
 * gate's message and the blip's colour): a shut port reads 'forbidden' before
 * anything else, a missing travel permit next, and the legal-record test last,
 * so a criminal at a permit-gated port is told about the permit.
 */
export function stellarClearance(stellar: ClearanceStellar,
    player: ClearancePlayer): StellarClearance {
    // A gate is entered, not landed on: MinStatus never applies (see the
    // module comment's exemption 2).
    if (stellar.gate) {
        return CLEARED;
    }
    // A paid bribe buys clearance past EVERY denial reason for as long as it
    // lasts — the stock bribe lines are explicit that this is what the money
    // buys ("We'll let you slip by the security barrier if you pay us.",
    // "Pay us and we'll look the other way if you want to visit our
    // spaceport." — STR# 3002 indices 40 and 44).
    if (player.bribed) {
        return CLEARED;
    }
    // The Bible's own parenthesis: no traffic control, no clearance to deny.
    if (stellar.flags.uninhabited) {
        return CLEARED;
    }
    if (stellar.minStatus === MIN_STATUS_NEVER) {
        return { cleared: false, reason: 'forbidden' };
    }
    if (!govtRequirementsMet(player.govtRequire, player.contribute)) {
        return { cleared: false, reason: 'permit' };
    }
    if (stellar.minStatus === MIN_STATUS_IGNORED) {
        return CLEARED;
    }
    if (player.record < stellar.minStatus) {
        return { cleared: false, reason: 'hostile' };
    }
    return CLEARED;
}

/** Convenience: the denial reason, or undefined when cleared. */
export function clearanceDenial(clearance: StellarClearance):
    ClearanceDenial | undefined {
    return clearance.cleared ? undefined : clearance.reason;
}

/**
 * The player's legal record with a stellar's owning government — "your record
 * in the current system", under NovaJS's per-govt record model. Independent
 * stellars (no govt) read 0.
 */
export function stellarRecord(planetGovt: GovtData | undefined,
    records: LegalRecords | undefined): number {
    if (!planetGovt || !records) {
        return planetGovt?.initialRecord ?? 0;
    }
    return recordWith(records, planetGovt.id, planetGovt);
}

/**
 * The whole decision from the pieces every caller already has: the stellar's
 * parsed data, its government, the player's records, Contribute bits, and
 * bribe map. `bribedUntil` is the expiry read out of StellarBribesComponent
 * (planet_plugin) and `now` the simulation clock — a bribe whose expiry has
 * passed simply isn't applied, so no one has to prune the map.
 */
export function planetClearance(opts: {
    planet: Pick<PlanetData, 'minStatus' | 'flags' | 'gate'>,
    planetGovt?: GovtData,
    records?: LegalRecords,
    contribute?: bigint,
    bribedUntil?: number,
    now?: number,
}): StellarClearance {
    const bribed = opts.bribedUntil !== undefined
        && opts.bribedUntil > (opts.now ?? 0);
    return stellarClearance(opts.planet, {
        record: stellarRecord(opts.planetGovt, opts.records),
        govtRequire: opts.planetGovt?.require,
        contribute: opts.contribute,
        bribed,
    });
}
