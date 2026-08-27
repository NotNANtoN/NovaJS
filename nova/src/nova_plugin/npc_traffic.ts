/**
 * Decisions for ambient NPC journeys.
 *
 * This module deliberately has no ECS or rendering imports. The Bible gives
 * trader AI the job of visiting planets; the distances, dwell cadence, and
 * departure chance below are NovaJS simulation policy where the Bible is silent.
 */

export type TrafficRandom = () => number;

export type TrafficPhase =
    | 'arriving'
    | 'travelling'
    /** Parked at a stellar for its stay, in plain sight. */
    | 'docked'
    | 'departing';

export interface NpcTrafficState {
    phase: TrafficPhase;
    destination?: string;
    readyAt: number;
}

export interface TrafficDestination {
    uuid: string;
    id: string;
    distanceSquared: number;
    canLand: boolean | undefined;
    inhabited: boolean | undefined;
}

export type TrafficLandingDecision =
    | 'select'
    | 'wait'
    | 'land'
    | 'depart';

/**
 * A docking ship stops existing, so it has to be visually over the stellar
 * when that happens. The player's own landing range of 500 is far too wide
 * here: it let traders blink out in open space, several ship lengths short of
 * the body, which reads as ships appearing and vanishing for no reason.
 */
export const TRAFFIC_LANDING_RANGE = 150;
export const TRAFFIC_LANDING_RANGE_SQUARED =
    TRAFFIC_LANDING_RANGE ** 2;
/** Retail's player landing speed limit, reused for NPC docking. */
export const TRAFFIC_LANDING_MAX_SPEED_SQUARED = 3_000;
/** Fly onto the body rather than halting outside the docking range. */
export const TRAFFIC_APPROACH_STANDOFF = 60;

/**
 * These times are simulation policy, not resource fields documented by the
 * Bible. A short stay makes traffic visible without keeping every ship docked.
 */
export const TRAFFIC_DWELL_MIN_MS = 12_000;
export const TRAFFIC_DWELL_MAX_MS = 30_000;
/** A docked trader sometimes finishes its business and leaves the system. */
export const TRAFFIC_DEPARTURE_CHANCE = 0.25;

function normalizedSample(random: TrafficRandom): number {
    const sample = random();
    return Number.isFinite(sample)
        ? Math.max(0, Math.min(1, sample))
        : 0;
}

function isValidDestination(candidate: TrafficDestination): boolean {
    return candidate.canLand === true && candidate.inhabited === true;
}

export function createArrivingTrafficState(
    readyAt = 0,
): NpcTrafficState {
    return { phase: 'arriving', readyAt };
}

/**
 * Pick a valid inhabited, landable stellar. Sorting makes the same random
 * sample stable even when an ECS query's iteration order changes.
 */
export function chooseTrafficDestination(
    candidates: readonly TrafficDestination[],
    random: TrafficRandom,
    excludedUuid?: string,
): TrafficDestination | undefined {
    const available = candidates
        .filter(candidate =>
            candidate.uuid !== excludedUuid
            && isValidDestination(candidate))
        .sort((a, b) => a.uuid.localeCompare(b.uuid));
    if (available.length === 0) {
        return undefined;
    }
    const index = Math.min(
        available.length - 1,
        Math.floor(normalizedSample(random) * available.length),
    );
    return available[index];
}

/**
 * Select a hyperspace link only from links whose system records are already
 * available. This mirrors NpcPurposeAI's conservative departure behavior.
 */
export function chooseTrafficDeparture(
    links: readonly string[],
    availableSystems: ReadonlySet<string>,
    random: TrafficRandom,
): string | undefined {
    const available = [...new Set(links)]
        .filter(link => availableSystems.has(link))
        .sort((a, b) => a.localeCompare(b));
    if (available.length === 0) {
        return undefined;
    }
    const index = Math.min(
        available.length - 1,
        Math.floor(normalizedSample(random) * available.length),
    );
    return available[index];
}

/**
 * Decide whether the ship should select, keep approaching, dock, or give up
 * on a stellar. Missing landing metadata is treated conservatively as a
 * departure because the server cannot establish that the stellar is usable.
 */
export function decideTrafficLanding(
    currentTarget: string | undefined,
    candidate: TrafficDestination | undefined,
    distanceSquared: number,
    velocitySquared: number,
): TrafficLandingDecision {
    if (!candidate) {
        return 'depart';
    }
    if (currentTarget !== candidate.uuid) {
        return 'select';
    }
    if (!isValidDestination(candidate)) {
        return 'depart';
    }
    if (!Number.isFinite(distanceSquared)
        || !Number.isFinite(velocitySquared)
        || distanceSquared > TRAFFIC_LANDING_RANGE_SQUARED
        || velocitySquared > TRAFFIC_LANDING_MAX_SPEED_SQUARED) {
        return 'wait';
    }
    return 'land';
}

/**
 * Combat, retreat, jumping, and destruction always suspend an errand. The
 * traffic system uses this predicate before changing state or deleting a
 * ship, so a live combat target remains authoritative.
 */
export function shouldYieldToCombat(
    hasLiveTarget: boolean,
    isFleeing: boolean,
    isJumping: boolean,
    isDestroyed: boolean,
): boolean {
    return hasLiveTarget || isFleeing || isJumping || isDestroyed;
}

export function trafficDwellDuration(
    random: TrafficRandom,
    minimum = TRAFFIC_DWELL_MIN_MS,
    maximum = TRAFFIC_DWELL_MAX_MS,
): number {
    const safeMinimum = Number.isFinite(minimum)
        ? Math.max(0, minimum) : TRAFFIC_DWELL_MIN_MS;
    const safeMaximum = Number.isFinite(maximum)
        ? Math.max(safeMinimum, maximum) : Math.max(
            safeMinimum, TRAFFIC_DWELL_MAX_MS);
    return safeMinimum
        + normalizedSample(random) * (safeMaximum - safeMinimum);
}

export function shouldTrafficDepart(
    random: TrafficRandom,
    chance = TRAFFIC_DEPARTURE_CHANCE,
): boolean {
    const safeChance = Number.isFinite(chance)
        ? Math.max(0, Math.min(1, chance))
        : TRAFFIC_DEPARTURE_CHANCE;
    if (safeChance === 0) {
        return false;
    }
    if (safeChance === 1) {
        return true;
    }
    return normalizedSample(random) > 1 - safeChance;
}
