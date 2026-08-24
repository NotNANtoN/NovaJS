import { v4 as uuid } from 'uuid';

export const PLAYER_TOKEN_STORAGE_KEY = 'nova.playerToken';

/**
 * Returns the stable identity for this browser profile. Storage failures
 * (private browsing and disabled storage are common examples) degrade to an
 * in-memory token rather than preventing a game from starting.
 */
export function getPersistentPlayerToken(
    storage?: Pick<Storage, 'getItem' | 'setItem'>,
): string {
    const browserStorage = storage ?? (
        typeof localStorage === 'undefined' ? undefined : localStorage);
    try {
        const existing = browserStorage?.getItem(PLAYER_TOKEN_STORAGE_KEY);
        if (existing) {
            return existing;
        }
        const token = uuid();
        browserStorage?.setItem(PLAYER_TOKEN_STORAGE_KEY, token);
        return token;
    } catch {
        return uuid();
    }
}

