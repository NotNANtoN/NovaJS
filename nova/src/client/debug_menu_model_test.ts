import 'jasmine';
import {
    adjustedOutfitCount,
    catalogFrom,
    DEBUG_TOKEN_STORAGE_KEY,
    filterCatalog,
    parseBitNumber,
    parseWholeNumber,
    readDebugToken,
    setBits,
} from './debug_menu_model';

class MemoryStorage {
    values = new Map<string, string>();
    getItem(key: string) { return this.values.get(key) ?? null; }
    setItem(key: string, value: string) { this.values.set(key, value); }
    removeItem(key: string) { this.values.delete(key); }
}

describe('debug menu model', () => {
    it('stores the ?debug token, reuses it, and forgets it on ?debug=off', () => {
        const storage = new MemoryStorage();
        expect(readDebugToken('', storage)).toBeUndefined();
        expect(readDebugToken('?debug=abc123&movement=legacy', storage)).toBe('abc123');
        expect(storage.getItem(DEBUG_TOKEN_STORAGE_KEY)).toBe('abc123');
        expect(readDebugToken('?other=1', storage)).toBe('abc123');
        expect(readDebugToken('?debug=off', storage)).toBeUndefined();
        expect(storage.getItem(DEBUG_TOKEN_STORAGE_KEY)).toBeNull();
        expect(readDebugToken('?debug=', storage)).toBeUndefined();
    });

    it('still reads the URL when storage throws', () => {
        const broken = {
            getItem: () => { throw new Error('denied'); },
            setItem: () => { throw new Error('denied'); },
            removeItem: () => { throw new Error('denied'); },
        };
        expect(readDebugToken('?debug=xyz', broken)).toBe('xyz');
        expect(readDebugToken('', broken)).toBeUndefined();
    });

    it('filters catalogs by name, id and hidden flag', () => {
        const entries = catalogFrom({
            'nova:130': { name: 'Kestrel', displayWeight: 100 },
            'nova:128': { name: 'Shuttle', displayWeight: 10, subtitle: 'Civilian' },
            'nova:400': { name: 'Kestrel (pirate)', displayWeight: 0 },
        }, { hideZeroWeight: true });
        expect(filterCatalog(entries, '').map(entry => entry.id)).toEqual(['nova:128', 'nova:130']);
        expect(filterCatalog(entries, 'kestrel', { includeHidden: true }).map(entry => entry.id))
            .toEqual(['nova:130', 'nova:400']);
        expect(filterCatalog(entries, '128').map(entry => entry.name)).toEqual(['Shuttle']);
        expect(filterCatalog(entries, 'civ shut').map(entry => entry.id)).toEqual(['nova:128']);
        expect(filterCatalog(entries, '', { includeHidden: true, limit: 1 }).length).toBe(1);
    });

    it('parses bits and numbers strictly', () => {
        expect(parseBitNumber('b100')).toBe(100);
        expect(parseBitNumber(' 9999 ')).toBe(9999);
        expect(parseBitNumber('10000')).toBeUndefined();
        expect(parseBitNumber('-1')).toBeUndefined();
        expect(parseBitNumber('1e3')).toBeUndefined();
        expect(parseWholeNumber('1,000,000', 0, 2e9)).toBe(1_000_000);
        expect(parseWholeNumber('-5', 0, 10)).toBeUndefined();
        expect(parseWholeNumber('1.5', 0, 10)).toBeUndefined();
    });

    it('clamps outfit counts', () => {
        expect(adjustedOutfitCount(2, 3)).toBe(5);
        expect(adjustedOutfitCount(2, -5)).toBe(0);
        expect(adjustedOutfitCount(2, 10, 4)).toBe(4);
        expect(setBits([false, true, false, true])).toEqual([1, 3]);
    });
});
