import { PersData } from 'novadatainterface/pers_data';
import { ShipData } from 'novadatainterface/ship_data';

/**
 * ============================================================================
 * Missions offered BY A SHIP (mïsn AvailLoc 2, "Offered from ship")
 * ============================================================================
 *
 * The Bible's AvailLoc 2 reads "Offered from ship (must set up associated
 * përs resource as well)", and the përs is where the trigger lives:
 *
 *   përs Flags 0x0200  "Offer ship's LinkMission when boarding it instead
 *                       of when hailing it"
 *
 * So a përs with a LinkMission offers it on HAILING by default, and on
 * BOARDING when that bit is set. Both stock cases are in the Drifting
 * Derelicts (govt 160, whose Flags1 0x0800 already makes them spawn as
 * hulks): the 0x0200 ones offer mïsn 134 "Passengers for <DST>" and mïsn
 * 133 "Derelict Decoy" when you board the wreck, and the Refuel Trader
 * përs offer mïsn 141/650/651/652 when you hail them.
 *
 * This module is the PURE half — which mission a ship offers and whether
 * it may be offered right now. It has no ECS or PIXI imports so the
 * display plugins that trigger it (hail and boarding) and the specs can
 * all share one answer.
 */

/** Where a përs's LinkMission is offered. */
export type ShipOfferTrigger = 'hail' | 'board';

/**
 * How this përs offers its LinkMission, or null when it has none.
 * përs Flags 0x0200 is the only thing that decides it.
 */
export function shipOfferTrigger(pers: PersData): ShipOfferTrigger | null {
    if (!pers.linkMission) {
        return null;
    }
    return pers.flags.offerMissionOnBoarding ? 'board' : 'hail';
}

/** What the përs gates its offer on, as facts the caller has resolved. */
export interface ShipOfferContext {
    /** The trigger that fired. */
    trigger: ShipOfferTrigger;
    /** The përs ship is currently disabled (përs Flags 0x0020). */
    disabled: boolean;
    /** It is attacking the player (përs Flags 0x0010). */
    attackingPlayer: boolean;
    /** It holds a grudge against the player (përs Flags 0x0004). */
    holdsGrudge: boolean;
    /** Its government likes the player (përs Flags 0x0008). */
    likesPlayer: boolean;
    /** The player already has this mission, or it is not offerable to
     * them right now (NCB / AvailRandom / cargo space). */
    missionAvailable: boolean;
    /** The PLAYER's ship class, for the three "no mission if..." bits. */
    playerShip: ShipData | undefined;
}

/**
 * Whether this përs will actually make its offer.
 *
 * The hail-only gates (0x0004 grudge, 0x0008 likes-you, 0x0010 attacking,
 * 0x0020 disabled, 0x0400 mission-available) are named for hailing in the
 * Bible, and they are applied to BOTH triggers here: they describe when
 * the person is willing to talk to you at all, and a boarding is a
 * conversation too. The one that would be actively wrong to skip is
 * 0x0020: the derelicts that offer on boarding are hulks, so a gate that
 * only ran on hails would let them be skipped entirely.
 *
 * The three "no mission if..." bits (0x1000 wimpy trader, 0x2000 beefy
 * trader, 0x4000 warship) are about the PLAYER'S ship, not the përs's —
 * the Bible's way of keeping a courier job away from a battleship. They
 * are resolved from the player's shïp InherentAI: 1-2 are the Bible's
 * "Freighters (i.e. AiTypes 1 and 2)", 3 and up are warships, and the
 * wimpy/beefy split is AIType 1 vs 2.
 */
export function shipOffers(pers: PersData, ctx: ShipOfferContext): boolean {
    if (!pers.linkMission || shipOfferTrigger(pers) !== ctx.trigger) {
        return false;
    }
    if (!ctx.missionAvailable) {
        return false;
    }
    const flags = pers.flags;
    if (flags.hailOnlyWhenDisabled && !ctx.disabled) {
        return false;
    }
    if (flags.hailOnlyWhenAttacking && !ctx.attackingPlayer) {
        return false;
    }
    if (flags.hailOnlyWithGrudge && !ctx.holdsGrudge) {
        return false;
    }
    if (flags.hailOnlyWhenLikesPlayer && !ctx.likesPlayer) {
        return false;
    }
    const playerAi = ctx.playerShip?.inherentAI;
    if (playerAi !== undefined) {
        if (flags.noMissionIfWimpyTrader && playerAi === 1) {
            return false;
        }
        if (flags.noMissionIfBeefyTrader && playerAi === 2) {
            return false;
        }
        if (flags.noMissionIfWarship && playerAi >= 3) {
            return false;
        }
    }
    return true;
}

/**
 * What accepting the offer does to the OFFERING SHIP itself, from the
 * përs flags. Applied sim-side against `offeredBy` (mission_accept).
 *
 *  - 0x0040 replaceWithSpecialShip: "When its LinkMission (with a single
 *    special ship) is accepted, the special ship replaces this përs ship
 *    in place." This is how the Refuel Trader works — you hail a flying
 *    trader, and the ship you then go and board is the mission's own
 *    special ship, spawned disabled by its rescue goal, sitting where the
 *    përs was.
 *  - 0x0800 leavesAfterMissionAccepted: the person departs once you take
 *    the job.
 *
 * Both remove the përs hull from play; they differ in what takes its
 * place, so they are reported separately rather than collapsed.
 */
export function shipOfferConsequence(pers: PersData):
    'replace' | 'leave' | 'stay' {
    if (pers.flags.replaceWithSpecialShip) {
        return 'replace';
    }
    if (pers.flags.leavesAfterMissionAccepted) {
        return 'leave';
    }
    return 'stay';
}
