import { GovtData } from 'novadatainterface/govt_data';
import { Disposition, shipDisposition } from './iff_plugin.js';
import { LegalRecords } from './reputation.js';

/**
 * ============================================================================
 * Hailing — pure response / eligibility logic (EVN Bible)
 * ============================================================================
 *
 * Hailing a ship or planet opens a communications dialog. This module holds
 * the pure, deterministic decisions behind that dialog — which are computed
 * identically on the display (to show the right text and buttons) and in the
 * sim (to apply repairs / bribes) — with no PIXI or ECS dependencies so they
 * can be unit-tested and shared across both worlds.
 *
 * Bible citations (packages/nova/EVN_Bible.txt):
 *  - gövt Flags1 0x0400 "Can't hail ships of this govt" (cantBeHailed): the
 *    ship simply does not answer.
 *  - gövt Flags1 0x0200 "Warships will take bribes" (warshipsTakeBribes),
 *    0x2000 "Freighters will take bribes" (freightersTakeBribes),
 *    0x8000 "Ships taking bribes demand a larger percentage ... and their
 *    planets always take bribes" (largerBribes), 0x0400/0x4000 planet bribes
 *    (planetsTakeBribes / largerBribes).
 *  - gövt Flags2 0x0001 "the request assistance / beg for mercy button is
 *    disabled and the govt is not talkative" (noAssistOrMercy).
 *  - gövt Flags2 0x0008 "don't send distress messages and don't respond with
 *    greetings when hailed" (noDistressMessages).
 *  - gövt Flags2 0x0010 "Roadside Assistance — always repair or refuel the
 *    player for free" (roadsideAssistance).
 *  - ränk Flags 0x0800 "Ships allied with the affiliated govt will always
 *    repair or refuel the player for free" (allied-repair): not applied here
 *    because per-player rank state is not yet modelled — a documented seam
 *    (see assistIsFree).
 *  - shïp/pers CommQuote (STR# 7100) is the comms-dialog greeting; a pers
 *    ship's is resolved into PersData.commQuote. Generic govt greetings
 *    (dude InfoTypes 0x8000 → STR# resources) are not parsed, so a synthetic
 *    govt-appropriate line stands in (greetingText) — a documented gap.
 */

/** Which of the two AI-type bribe flags applies to a ship of this aiType. */
export function shipTakesBribes(govt: GovtData | undefined,
    aiType: number | undefined): boolean {
    if (!govt) {
        return false;
    }
    if (govt.flags.largerBribes) {
        // Pirates: always take (larger) bribes regardless of ship kind.
        return true;
    }
    // aiType 1/2 = freighters, 3 = warship. Unknown aiType (independent /
    // player-spawned) uses the warship flag as the general "will bargain"
    // signal.
    if (aiType === 1 || aiType === 2) {
        return govt.flags.freightersTakeBribes;
    }
    return govt.flags.warshipsTakeBribes;
}

/**
 * The fraction of the player's cash a bribe costs. TUNABLE / ASSUMPTION: the
 * Bible only says "ships taking bribes will demand a larger percentage" for
 * largerBribes govts and gives no exact numbers. 10% is the ordinary demand;
 * pirate/largerBribes govts demand 30%. A pure function of the player's cash
 * and the flag, so the display and the sim agree without a random roll.
 */
export const BRIBE_FRACTION = 0.10;
export const BRIBE_FRACTION_LARGE = 0.30;
/** A bribe is never smaller than this (so a near-broke player still pays). */
export const BRIBE_MINIMUM = 500;

/**
 * The credits a bribe/mercy plea costs, given the player's current cash and
 * whether the govt demands larger bribes. Rounded down to a whole credit and
 * capped at what the player actually has. Pure and total.
 */
export function bribeAmount(playerCredits: number,
    largerBribes: boolean): number {
    const fraction = largerBribes ? BRIBE_FRACTION_LARGE : BRIBE_FRACTION;
    const demand = Math.max(BRIBE_MINIMUM, Math.floor(playerCredits * fraction));
    return Math.min(demand, Math.max(0, Math.floor(playerCredits)));
}

/** What a hailed ship's answer amounts to, driving the dialog contents. */
export type ShipHailResponse =
    /** The ship can't be hailed at all (Flags1 cantBeHailed). */
    | { kind: 'cantHail' }
    /** Hostile: it's attacking / would attack the player. */
    | { kind: 'hostile', canBribe: boolean }
    /** Ordinary answer: a greeting (possibly empty when suppressed). */
    | { kind: 'greeting', talkative: boolean };

/**
 * How a hailed ship responds to the player, from the ship's government and
 * disposition. `disposition` is the same reading the radar/target-corners
 * use (shipDisposition). `aiType` selects the bribe flag; `takesBribes` is
 * exposed so the caller need not re-derive it.
 */
export function shipHailResponse(govt: GovtData | undefined,
    disposition: Disposition, aiType: number | undefined): ShipHailResponse {
    if (govt?.flags.cantBeHailed) {
        return { kind: 'cantHail' };
    }
    if (disposition === 'hostile') {
        // Beg for mercy / bribe is offered only when the govt bargains and
        // is not the silent, un-negotiable type (Flags2 noAssistOrMercy).
        const canBribe = !govt?.flags2.noAssistOrMercy
            && shipTakesBribes(govt, aiType);
        return { kind: 'hostile', canBribe };
    }
    // noDistressMessages govts answer but don't greet ("not talkative"); the
    // noAssistOrMercy flag also marks a govt as "not talkative".
    const talkative = !(govt?.flags2.noDistressMessages
        || govt?.flags2.noAssistOrMercy);
    return { kind: 'greeting', talkative };
}

/**
 * Whether the player may request fuel/repair assistance from a hailed ship.
 * Requires that the player actually needs help (disabled or low on fuel),
 * the ship is not hostile, and the govt is talkative (not Flags2
 * noAssistOrMercy). Roadside-Assistance govts still gate on player need —
 * they repair/refuel, they don't hand out charity to a healthy ship.
 */
export function canRequestAssistance(opts: {
    disposition: Disposition,
    playerNeedsHelp: boolean,
    govt: GovtData | undefined,
}): boolean {
    if (!opts.playerNeedsHelp || opts.disposition === 'hostile') {
        return false;
    }
    if (opts.govt?.flags.cantBeHailed || opts.govt?.flags2.noAssistOrMercy) {
        return false;
    }
    return true;
}

/**
 * Whether the assistance is free. Roadside-Assistance govts (Flags2 0x0010)
 * always repair/refuel for free. The ränk allied-repair flag (0x0800) would
 * also make it free, but per-player rank state is not modelled yet — a
 * documented seam. Non-free assistance is currently also rendered for free
 * (there is no "charge for fuel" credit model yet); this helper still reports
 * the distinction so the dialog can word the offer, and so a future charge
 * can hook in here.
 */
export function assistIsFree(govt: GovtData | undefined): boolean {
    return !!govt?.flags2.roadsideAssistance;
}

/** Whether a hailed planet's government will take a bribe (hostile planets). */
export function planetTakesBribes(govt: GovtData | undefined): boolean {
    return !!govt && (govt.flags.planetsTakeBribes || govt.flags.largerBribes);
}

/**
 * The greeting line shown in the comms dialog. A pers ship's resolved
 * CommQuote (STR# 7100) wins when present; otherwise a synthetic
 * govt-appropriate line stands in for the unparsed generic govt greetings
 * (dude InfoTypes 0x8000). Returns '' when the govt is not talkative
 * (noDistressMessages / noAssistOrMercy) — the caller shows "no response".
 */
export function greetingText(opts: {
    persCommQuote?: string,
    govtCommName?: string,
    talkative: boolean,
}): string {
    if (!opts.talkative) {
        return '';
    }
    if (opts.persCommQuote && opts.persCommQuote.trim() !== '') {
        return opts.persCommQuote;
    }
    const who = opts.govtCommName && opts.govtCommName.trim() !== ''
        ? opts.govtCommName
        : 'this vessel';
    return `Greetings from ${who}. Fly safe, captain.`;
}

/** The response line for a hostile ship (no pers quote). */
export function hostileText(govtCommName?: string): string {
    const who = govtCommName && govtCommName.trim() !== ''
        ? govtCommName
        : 'The other ship';
    return `${who} responds with hostility and refuses to talk.`;
}
