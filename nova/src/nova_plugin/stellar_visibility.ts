import { PlanetData } from 'novadatainterface/PlanetData';
import { isStellarDestroyed, PlayerState } from './player_state';

/**
 * How a stellar is presented to one pilot. Destruction is per pilot: only
 * the pilot who destroyed a stellar sees its DeadType graphic (or nothing);
 * everyone else in the room keeps the living stellar.
 */
export type StellarPresentation = 'normal' | 'dead' | 'hidden';

type DestroyedState = Pick<PlayerState, 'destroyedStellars'> | undefined;

export function stellarPresentation(
    state: DestroyedState,
    planet: Pick<PlanetData, 'id' | 'deadType' | 'deadAnimation'>,
): StellarPresentation {
    if (!state || !isStellarDestroyed(state, planet.id)) {
        return 'normal';
    }
    // DeadType -1: no different graphic, the stellar simply disappears.
    return (planet.deadType ?? -1) >= 0 && planet.deadAnimation
        ? 'dead' : 'hidden';
}

/** Destroyed stellars cannot be targeted, cycled to, shown on radar or landed on. */
export function isStellarTargetable(
    state: DestroyedState,
    planetId: string,
): boolean {
    return !state || !isStellarDestroyed(state, planetId);
}

export function targetableStellars<T>(
    rows: Iterable<T>,
    planetId: (row: T) => string,
    state: DestroyedState,
): T[] {
    return [...rows].filter(row => isStellarTargetable(state, planetId(row)));
}
