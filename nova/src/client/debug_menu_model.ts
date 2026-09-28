/**
 * Pure helpers behind the debug menu (nova/src/client/debug_menu.ts), kept
 * free of DOM and ECS so they can be unit tested.
 */

export const DEBUG_TOKEN_STORAGE_KEY = 'novaDebugToken';

type TokenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The debug token for this browser: `?debug=<token>` stores it so reloads
 * keep it, `?debug=off` (or an empty value) forgets it, and without the
 * parameter the stored token is used. The server still has to accept it.
 */
export function readDebugToken(search: string, storage?: TokenStorage): string | undefined {
    let fromUrl: string | null = null;
    try {
        fromUrl = new URLSearchParams(search).get('debug');
    } catch {
        fromUrl = null;
    }
    try {
        if (fromUrl !== null) {
            const token = fromUrl.trim();
            if (!token || token === 'off' || token === '0') {
                storage?.removeItem(DEBUG_TOKEN_STORAGE_KEY);
                return undefined;
            }
            storage?.setItem(DEBUG_TOKEN_STORAGE_KEY, token);
            return token;
        }
        return storage?.getItem(DEBUG_TOKEN_STORAGE_KEY) ?? undefined;
    } catch {
        return fromUrl?.trim() || undefined;
    }
}

export interface CatalogEntry {
    id: string;
    name: string;
    /** Extra searchable text shown after the name (e.g. a subtitle). */
    detail?: string;
    /** Retail never offers entries with displayWeight <= 0 (NPC-only hulls). */
    hidden?: boolean;
}

function bareId(id: string): string {
    return id.replace(/^.*:/, '');
}

/**
 * Case-insensitive substring match over name, detail and id (`137`,
 * `nova:137`). Results sort by numeric resource id, then name.
 */
export function filterCatalog<T extends CatalogEntry>(entries: readonly T[], query: string,
    options: { includeHidden?: boolean; limit?: number } = {}): T[] {
    const terms = (query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = entries.filter(entry => {
        if (entry.hidden && !options.includeHidden) return false;
        const haystack = `${entry.name} ${entry.detail ?? ''} ${entry.id}`.toLowerCase();
        return terms.every(term => haystack.includes(term));
    });
    matches.sort((a, b) => {
        const na = Number(bareId(a.id));
        const nb = Number(bareId(b.id));
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
        return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
    return options.limit === undefined ? matches : matches.slice(0, options.limit);
}

/** Catalog entries from preloaded resources keyed by id. */
export function catalogFrom(records: Readonly<Record<string, {
    name?: string; displayWeight?: number; subtitle?: string;
} | undefined>> | undefined, options: { hideZeroWeight?: boolean } = {}): CatalogEntry[] {
    return Object.entries(records ?? {}).map(([id, record]) => ({
        id,
        name: record?.name || id,
        detail: record?.subtitle || undefined,
        hidden: options.hideZeroWeight
            ? (record?.displayWeight ?? 1) <= 0 : false,
    }));
}

/** A control bit number (EV Nova has bits 0-9999), or undefined. */
export function parseBitNumber(value: string): number | undefined {
    const text = value.trim().replace(/^b/i, '');
    if (!/^\d{1,4}$/.test(text)) return undefined;
    const bit = Number(text);
    return bit >= 0 && bit <= 9999 ? bit : undefined;
}

/** A whole number within [min, max], or undefined. */
export function parseWholeNumber(value: string, min: number, max: number): number | undefined {
    const text = value.trim().replace(/[,_\s]/g, '');
    if (!/^-?\d+$/.test(text)) return undefined;
    const number = Number(text);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : undefined;
}

/** The new outfit count after giving (+) or removing (-) some. */
export function adjustedOutfitCount(current: number, delta: number, max?: number): number {
    const next = Math.max(0, Math.floor(current) + Math.floor(delta));
    return max !== undefined && max > 0 ? Math.min(next, max) : next;
}

/** The set bits in a mission-bit array, for a compact summary. */
export function setBits(bits: readonly boolean[] | undefined, limit = 200): number[] {
    const result: number[] = [];
    for (let bit = 0; bit < (bits?.length ?? 0) && result.length < limit; bit++) {
        if (bits![bit]) result.push(bit);
    }
    return result;
}
