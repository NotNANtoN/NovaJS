import { isRight } from 'nova_ecs/either';
import {
    createInitialPlayerState,
    decodePlayerState,
    PlayerState,
} from '../nova_plugin/player_state';

export const NEW_PILOT_TIMEOUT_MS = 5_000;

/**
 * A New Pilot's starting state as the server grants it (chär start system,
 * date, ship, legal records; `GET /player/new-pilot`). Falls back to the
 * local defaults when the server is older, unreachable or answers with
 * something that is not a valid pilot.
 */
export async function fetchNewPilotState(
    fetchImpl: typeof fetch | undefined = globalThis.fetch,
    timeoutMs = NEW_PILOT_TIMEOUT_MS,
): Promise<PlayerState> {
    if (typeof fetchImpl !== 'function') {
        return createInitialPlayerState();
    }
    const controller = typeof AbortController === 'function'
        ? new AbortController() : undefined;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
        const response = await fetchImpl('/player/new-pilot',
            controller ? { signal: controller.signal } : undefined);
        if (!response.ok) {
            return createInitialPlayerState();
        }
        const decoded = decodePlayerState(await response.json() as unknown);
        return isRight(decoded) ? decoded.right : createInitialPlayerState();
    } catch {
        return createInitialPlayerState();
    } finally {
        clearTimeout(timer);
    }
}
