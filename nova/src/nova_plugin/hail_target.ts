/**
 * Working out who the pilot is hailing, and how that ship feels about them.
 *
 * This is kept apart from the dialog so the decision can be tested without a
 * renderer, and apart from the comms text tables so it can consult the ECS.
 */

import { GovernmentData, GovernmentFlags } from './govt_relations';
import { hailRelation } from './comms';
import { isCriminal, recordFor } from './legal_record';
import { GovernmentRelation } from './govt_relations';

export interface HailCandidate {
    /** The hailed ship's display name. */
    name: string;
    /** The hailed ship's government, when it has one we could load. */
    government?: GovernmentData;
    /** True when that ship is currently targeting the pilot. */
    targetingPlayer: boolean;
    /** True when the ship belongs to the pilot's own fleet. */
    isEscort?: boolean;
}

export interface HailDescription {
    name: string;
    relation: GovernmentRelation;
    record: number;
    hostile: boolean;
    isEscort: boolean;
}

/**
 * A ship with no government to speak for it is treated as an indifferent
 * stranger rather than being unhailable, so mission ships and drones still
 * answer.
 */
export function describeHail(
    candidate: HailCandidate,
    legalRecords: Record<string, number> | undefined,
): HailDescription {
    const govt = candidate.government;
    const record = govt
        ? recordFor(legalRecords, String(govt.id), govt)
        : 0;
    const flags = govt?.flags ?? 0;
    const relation = hailRelation({
        record,
        crimeTolerance: govt?.crimeTolerance ?? 0,
        hostile: candidate.targetingPlayer,
        alwaysHostile: Boolean(flags & GovernmentFlags.alwaysAttacksPlayer)
            || Boolean(flags & GovernmentFlags.xenophobic)
            || Boolean(govt && isCriminal(record, govt.crimeTolerance ?? 0)),
    });
    return {
        name: candidate.name,
        relation,
        record,
        hostile: candidate.targetingPlayer,
        isEscort: Boolean(candidate.isEscort),
    };
}
