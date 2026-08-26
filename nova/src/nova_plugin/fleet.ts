/**
 * Pure flët roster and formation logic.
 *
 * The EV Nova Bible specifies the flagship and each escort type's minimum and
 * maximum counts, but does not specify the random distribution or a geometric
 * formation. Counts are therefore rolled uniformly over the inclusive range,
 * and formationSlot uses a deterministic staggered row behind the flagship.
 */

export interface FleetEscortDefinition {
    shipId: string,
    min: number,
    max: number,
}

export interface FleetDefinition {
    leaderShipId: string,
    escorts: readonly FleetEscortDefinition[],
}

export interface FleetRoster {
    leaderShipId: string,
    escortShipIds: string[],
}

export interface FormationOffset {
    x: number,
    y: number,
}

export const DEFAULT_FLEET_FORMATION_SPACING = 220;

function nonNegativeInteger(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizedRandom(random: number): number {
    return Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0;
}

/**
 * Roll one escort count from the Bible's inclusive Min/Max range.
 *
 * Retail records use non-negative integer bounds. If a malformed plug-in
 * supplies Max below Min, treating Max as Min avoids silently losing the
 * minimum the author requested.
 */
export function rollEscortCount(
    min: number,
    max: number,
    random: () => number = Math.random,
): number {
    const lower = nonNegativeInteger(min);
    const upper = Math.max(lower, nonNegativeInteger(max));
    const range = upper - lower;
    return lower + Math.min(
        range,
        Math.floor(normalizedRandom(random()) * (range + 1)),
    );
}

export function rollEscortCounts(
    escorts: readonly FleetEscortDefinition[],
    random: () => number = Math.random,
): number[] {
    return escorts.map(escort => rollEscortCount(
        escort.min,
        escort.max,
        random,
    ));
}

/**
 * Expand a normalized flët definition into the concrete ships to construct.
 * Repeated escort IDs are intentional: each occurrence is one ship in the
 * spawned fleet, and duplicate escort classes retain their separate ranges.
 */
export function composeFleetRoster(
    definition: FleetDefinition,
    random: () => number = Math.random,
): FleetRoster {
    const escortShipIds: string[] = [];
    for (const escort of definition.escorts) {
        const count = rollEscortCount(escort.min, escort.max, random);
        for (let ship = 0; ship < count; ship++) {
            escortShipIds.push(escort.shipId);
        }
    }
    return {
        leaderShipId: definition.leaderShipId,
        escortShipIds,
    };
}

/**
 * Return a local-space offset for one escort, with local +y behind the leader.
 * Two escorts share a row symmetrically; later rows widen behind them.
 */
export function formationSlot(
    slot: number,
    spacing = DEFAULT_FLEET_FORMATION_SPACING,
): FormationOffset {
    const index = nonNegativeInteger(slot);
    const distance = nonNegativeInteger(spacing);
    const row = Math.floor(index / 2) + 1;
    return {
        x: (index % 2 === 0 ? -1 : 1) * row * distance || 0,
        y: row * distance,
    };
}
