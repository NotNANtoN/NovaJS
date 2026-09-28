/**
 * Per-pilot stellar destruction (EV Nova Bible, spöb Strength / DeadTime /
 * OnDestroy / OnRegen).
 *
 * In a shared room one pilot must not delete a planet from everyone else's
 * galaxy, so the room only shares the fight: the planet's damage pool lives
 * on the server entity. When it breaks, every pilot who damaged it records
 * the stellar in their own `destroyedStellars` (which already blocks
 * landing), runs OnDestroy, and gets a regeneration date. Each client hides
 * or reskins stellars its own pilot destroyed; everyone else keeps seeing
 * the planet, whose shared pool regenerates.
 */
import { PlanetData } from 'novadatainterface/PlanetData';
import { executeSetOperations, parseSetExpression } from './ncb';
import { createNcbHandlers, NcbHandlerContext } from './ncb_handlers';
import {
    destroyStellar,
    isStellarDestroyed,
    PlayerState,
    regenerateStellar,
} from './player_state';
import { resourceId as canonicalResourceId, sameResourceId } from '../common/resource_id';

export type DestroyableStellar = Pick<PlanetData,
    'id' | 'strength' | 'deadTime' | 'onDestroy' | 'onRegen' | 'flags2'>;

/** spöb Strength of 0 or -1 means the stellar is invincible. */
export function isDestroyable(planet: Pick<PlanetData, 'strength'> | undefined): boolean {
    return (planet?.strength ?? 0) > 0;
}

/** spöb Flags2 0x0040: "Stellar starts the game destroyed." */
export function startsDestroyed(planet: Pick<PlanetData, 'flags2'>): boolean {
    return ((planet.flags2 ?? 0) & 0x0040) !== 0;
}

/**
 * gameDate on which a stellar destroyed on `today` regenerates.
 * DeadTime 0: "regenerates at the end of every day"; -1: never.
 */
export function regenerationDate(
    planet: Pick<PlanetData, 'deadTime'>,
    today: number,
): number | undefined {
    const deadTime = planet.deadTime ?? -1;
    if (deadTime < 0) return undefined;
    return today + Math.max(1, deadTime);
}

function runExpression(
    expression: string | undefined,
    state: PlayerState,
    context: Omit<NcbHandlerContext, 'state'>,
    logger: (message: string) => void,
) {
    if (!expression?.trim()) return;
    try {
        executeSetOperations(parseSetExpression(expression, { logger }),
            state.missionBits,
            { handlers: createNcbHandlers({ ...context, state, logger }), logger });
    } catch (error) {
        logger(`Could not run '${expression}': ${error}`);
    }
}

/**
 * Record that this pilot destroyed the stellar. Returns false when it was
 * already destroyed for them (OnDestroy runs once per destruction).
 */
export function recordStellarDestroyed(
    state: PlayerState,
    planet: DestroyableStellar,
    context: Omit<NcbHandlerContext, 'state'> = {},
    logger: (message: string) => void = console.warn,
): boolean {
    if (isStellarDestroyed(state, planet.id)) return false;
    destroyStellar(state, planet.id);
    const id = canonicalResourceId(planet.id);
    const regen = regenerationDate(planet, state.gameDate);
    const schedule = { ...(state.stellarRegen ?? {}) };
    if (regen === undefined) delete schedule[id];
    else schedule[id] = regen;
    state.stellarRegen = schedule;
    runExpression(planet.onDestroy, state, context, logger);
    return true;
}

/** Regenerate a stellar for this pilot and run its OnRegen. */
export function recordStellarRegenerated(
    state: PlayerState,
    planet: Pick<PlanetData, 'id' | 'onRegen'>,
    context: Omit<NcbHandlerContext, 'state'> = {},
    logger: (message: string) => void = console.warn,
): boolean {
    if (!isStellarDestroyed(state, planet.id)) return false;
    regenerateStellar(state, planet.id);
    if (state.stellarRegen) {
        const schedule = { ...state.stellarRegen };
        for (const key of Object.keys(schedule)) {
            if (sameResourceId(key, planet.id)) delete schedule[key];
        }
        state.stellarRegen = schedule;
    }
    runExpression(planet.onRegen, state, context, logger);
    return true;
}

/** Stellars whose regeneration date has arrived for this pilot. */
export function dueRegenerations(state: Pick<PlayerState, 'stellarRegen' | 'gameDate'>): string[] {
    return Object.entries(state.stellarRegen ?? {})
        .filter(([, date]) => date <= state.gameDate)
        .map(([id]) => id);
}
