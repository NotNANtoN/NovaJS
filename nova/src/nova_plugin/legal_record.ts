import { GovtData } from 'novadatainterface/GovtData';
import { relation } from './govt_relations';

/**
 * The player's standing with one government, and the crimes that move it.
 *
 * Retail keeps one signed record per government. Crimes subtract the
 * government's own penalty for that crime, so a government that does not care
 * about smuggling simply stores a zero. Allies of the victim share part of the
 * loss, and its enemies credit the player the same share, which is what makes
 * pirate-hunting raise your standing with the Federation and lower it with the
 * pirates.
 */

export type Crime =
    | 'smuggling'
    | 'disabling'
    | 'boarding'
    | 'killing'
    // Parsed and available, but never charged: the Bible marks gövt's
    // ShootPenalty as "currently ignored".
    | 'shooting';

/** Government id (as a resource id) to signed legal record. */
export type LegalRecords = Record<string, number>;

/**
 * Fraction of a penalty that spreads to the victim's allies and, with the
 * sign flipped, to its enemies. Retail does not publish this number; a third
 * keeps second-order effects visible without letting one kill swing the
 * galaxy.
 */
export const RELATION_SHARE = 1 / 3;

/**
 * The retail legal-record ladder, `STR#` 134. Index 0 and 1 are both
 * "No Record" because retail indexes this list from one in some places.
 * Entries 2-9 run from clean to hunted, 10-15 from citizen to virtuous, and
 * the last two are reserved for governments the player rules.
 */
export const LEGAL_STATUS_LADDER = [
    'No Record',
    'No Record',
    'No Convictions',
    'Minor Offender',
    'Offender',
    'Criminal',
    'Wanted Criminal',
    'Fugitive',
    'Hunted Fugitive',
    'Public Enemy',
    'Citizen',
    'Good Citizen',
    'Upstanding Citizen',
    'Leading Citizen',
    'Model Citizen',
    'Virtuous Citizen',
    'Military Dictator',
    'Military Governor',
] as readonly string[];

/** The retail combat-rating ladder, `STR#` 138. */
export const COMBAT_RATING_LADDER = [
    'No Ability',
    'Little Ability',
    'Fair Ability',
    'Average Ability',
    'Good Ability',
    'Competent',
    'Very Competent',
    'Worthy of Note',
    'Dangerous',
    'Deadly',
    'Frightening',
] as readonly string[];

/** "No Convictions", the first rung a pilot with any record can reach. */
const FIRST_CRIMINAL_RUNG = 2;
/** "Public Enemy", the worst rung. */
const LAST_CRIMINAL_RUNG = 9;
/** "Citizen", the first rung above a clean record. */
const FIRST_CITIZEN_RUNG = 10;
/** The two military rungs at the end are for governments the player rules. */
const RESERVED_RUNGS = 2;

/**
 * Where a record sits on the ladder. One rung is one tolerance-worth of
 * record, so a lenient government needs a far worse record before it calls
 * the player a criminal.
 */
export function legalStatusIndex(
    record: number,
    crimeTolerance: number,
    ladderLength = LEGAL_STATUS_LADDER.length,
): number {
    if (record === 0) {
        return 0;
    }
    // A tolerance of zero would divide by zero, and such a government
    // forgives nothing, so every point of record counts as a full rung.
    const scale = Math.max(1, Math.abs(crimeTolerance));
    const steps = Math.ceil(Math.abs(record) / scale);
    if (record < 0) {
        return Math.min(
            FIRST_CRIMINAL_RUNG - 1 + steps,
            Math.min(LAST_CRIMINAL_RUNG, ladderLength - 1),
        );
    }
    return Math.min(
        FIRST_CITIZEN_RUNG - 1 + steps,
        Math.max(FIRST_CITIZEN_RUNG, ladderLength - 1 - RESERVED_RUNGS),
    );
}

export function legalStatus(
    record: number,
    crimeTolerance: number,
    ladder: readonly string[] = LEGAL_STATUS_LADDER,
): string {
    if (ladder.length === 0) {
        return '';
    }
    const index = legalStatusIndex(record, crimeTolerance, ladder.length);
    return ladder[Math.min(index, ladder.length - 1)] ?? ladder[0];
}

/**
 * A government hunts the player once the record falls past its tolerance.
 * Retail compares against the negated tolerance, so a tolerance of 20 means
 * twenty points of crime are forgiven.
 */
export function isCriminal(record: number, crimeTolerance: number): boolean {
    return record < -Math.max(0, crimeTolerance);
}

/**
 * Retail's combat rating doubles the kills needed for each rung, so the first
 * rung is one kill, the next two, then four, and so on.
 */
export function combatRatingIndex(
    kills: number,
    ladderLength = COMBAT_RATING_LADDER.length,
): number {
    if (kills <= 0) {
        return 0;
    }
    const rung = Math.floor(Math.log2(kills)) + 1;
    return Math.min(rung, ladderLength - 1);
}

export function combatRating(
    kills: number,
    ladder: readonly string[] = COMBAT_RATING_LADDER,
): string {
    if (ladder.length === 0) {
        return '';
    }
    return ladder[combatRatingIndex(kills, ladder.length)] ?? ladder[0];
}

export function recordFor(
    records: LegalRecords | undefined,
    government: string,
    govt?: Pick<GovtData, 'initialRecord'>,
): number {
    const stored = records?.[government];
    if (stored !== undefined) {
        return stored;
    }
    return govt?.initialRecord ?? 0;
}

export function penaltyFor(
    govt: Pick<GovtData, 'penalties'> | undefined,
    crime: Crime,
): number {
    return govt?.penalties?.[crime] ?? 0;
}

export interface CrimeWitness {
    /** The government whose ship or property the player wronged. */
    victim: string;
    /** Every government that could revise its opinion, keyed by resource id. */
    governments: ReadonlyMap<string, GovtData>;
}

/**
 * Apply one crime and return the updated records. The result is a new object
 * so callers can hand it straight to Immer-backed player state.
 */
export function applyCrime(
    records: LegalRecords | undefined,
    crime: Crime,
    witness: CrimeWitness,
): LegalRecords {
    const next: LegalRecords = { ...(records ?? {}) };
    const victimGovt = witness.governments.get(witness.victim);
    const penalty = penaltyFor(victimGovt, crime);
    if (penalty === 0) {
        return next;
    }

    for (const [id, govt] of witness.governments) {
        let delta = 0;
        if (id === witness.victim) {
            delta = -penalty;
        } else if (victimGovt) {
            switch (relation(govt, victimGovt)) {
                case 'ally':
                    delta = -penalty * RELATION_SHARE;
                    break;
                case 'enemy':
                    delta = penalty * RELATION_SHARE;
                    break;
                default:
                    delta = 0;
            }
        }
        if (delta === 0) {
            continue;
        }
        const current = recordFor(next, id, govt);
        next[id] = Math.round(current + delta);
    }
    return next;
}
