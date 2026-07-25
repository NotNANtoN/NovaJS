import { SaveStorage } from './save_game.js';

/**
 * Client-local record of which systems the player has explored (entered),
 * backing the starmap's "<Unknown>" gating for unexplored systems'
 * properties. Persisted in localStorage beside the save.
 *
 * Deliberately NOT simulation state: exploration only affects player-local
 * UI (map readouts), so tracking it here keeps it out of the synced
 * component set entirely. If NCB Exxx tests / Xxxx operators ever need real
 * exploration, this store is the obvious backing for their player-local
 * evaluation too (they are evaluated display-side).
 *
 * A system is marked when its display world is built (starmap_plugin), i.e.
 * whenever the player is actually in it — including the starting system.
 * Nova's stacked NCB copies of a system have distinct global ids; only the
 * copy the player visited is marked, which matches how the copies swap.
 */
export const EXPLORED_KEY = 'novajs:explored';

function defaultStorage(): SaveStorage | undefined {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : undefined;
    } catch {
        // Accessing localStorage can throw (e.g. disabled cookies).
        return undefined;
    }
}

let cache: Set<string> | undefined;

function load(storage?: SaveStorage): Set<string> {
    if (cache) {
        return cache;
    }
    cache = new Set<string>();
    const store = storage ?? defaultStorage();
    if (!store) {
        return cache;
    }
    try {
        const raw = store.getItem(EXPLORED_KEY);
        if (raw) {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                for (const id of parsed) {
                    if (typeof id === 'string') {
                        cache.add(id);
                    }
                }
            }
        }
    } catch (e) {
        console.warn('Failed to load explored systems:', e);
    }
    return cache;
}

/** Marks a system as explored and persists the set. */
export function markExplored(systemId: string, storage?: SaveStorage) {
    const explored = load(storage);
    if (explored.has(systemId)) {
        return;
    }
    explored.add(systemId);
    const store = storage ?? defaultStorage();
    try {
        store?.setItem(EXPLORED_KEY, JSON.stringify([...explored]));
    } catch (e) {
        console.warn('Failed to persist explored systems:', e);
    }
}

export function isExplored(systemId: string, storage?: SaveStorage): boolean {
    return load(storage).has(systemId);
}

/** Forgets everything — a new pilot starts unexplored (see resetSave). */
export function resetExplored(storage?: SaveStorage) {
    cache = undefined;
    const store = storage ?? defaultStorage();
    try {
        store?.removeItem(EXPLORED_KEY);
    } catch {
        // Ignore.
    }
}
