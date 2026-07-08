import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { OutfitsState, OutfitsStateComponent } from './outfit_plugin.js';
import {
    decodeSave,
    encodeSave,
    extractSaveData,
    loadSave,
    resetSave,
    SaveData,
    SaveStorage,
    SAVE_KEY,
    SAVE_QUARANTINE_KEY,
    SAVE_VERSION,
    writeSave,
} from './save_game.js';
import { ShipComponent } from './ship_plugin.js';

/** An in-memory SaveStorage for tests. */
class FakeStorage implements SaveStorage {
    readonly items = new Map<string, string>();
    getItem(key: string): string | null {
        return this.items.has(key) ? this.items.get(key)! : null;
    }
    setItem(key: string, value: string): void {
        this.items.set(key, value);
    }
    removeItem(key: string): void {
        this.items.delete(key);
    }
}

const SAMPLE: SaveData = {
    ship: 'nova:164',
    outfits: [['nova:200', 1], ['nova:201', 4]],
    system: 'nova:130',
};

describe('save_game schema', () => {
    it('round-trips a save through encode and decode', () => {
        const decoded = decodeSave(encodeSave(SAMPLE));
        expect(decoded).toEqual(SAMPLE);
    });

    it('round-trips reserved optional fields when present', () => {
        const withReserved: SaveData = {
            ...SAMPLE,
            credits: 12345,
            reputations: [['nova:gov1', -50]],
        };
        const decoded = decodeSave(encodeSave(withReserved));
        expect(decoded).toEqual(withReserved);
    });

    it('extracts ship and outfits from a player entity', () => {
        const entity = new Entity('player');
        entity.components.set(ShipComponent, { id: 'nova:164' });
        const outfits: OutfitsState = new Map([
            ['nova:200', { count: 1 }],
            ['nova:201', { count: 4 }],
        ]);
        entity.components.set(OutfitsStateComponent, outfits);

        const data = extractSaveData(entity, 'nova:130');
        expect(data).toEqual(SAMPLE);
    });

    it('extracts an empty outfit list when the ship has no outfits', () => {
        const entity = new Entity('player');
        entity.components.set(ShipComponent, { id: 'nova:164' });
        const data = extractSaveData(entity, 'nova:131');
        expect(data).toEqual({ ship: 'nova:164', outfits: [], system: 'nova:131' });
    });

    it('returns undefined when the entity has no ship component', () => {
        const entity = new Entity('not a ship');
        expect(extractSaveData(entity, 'nova:130')).toBeUndefined();
    });
});

describe('save_game corrupt/version fallback', () => {
    it('rejects malformed JSON', () => {
        expect(decodeSave('{not json')).toBeUndefined();
    });

    it('rejects a payload with the wrong shape', () => {
        expect(decodeSave(JSON.stringify({
            version: SAVE_VERSION,
            data: { ship: 42 /* should be a string */ },
        }))).toBeUndefined();
    });

    it('rejects a save from a different schema version', () => {
        expect(decodeSave(JSON.stringify({
            version: SAVE_VERSION + 1,
            data: SAMPLE,
        }))).toBeUndefined();
    });

    it('rejects null and empty input', () => {
        expect(decodeSave(null)).toBeUndefined();
        expect(decodeSave(undefined)).toBeUndefined();
    });
});

describe('save_game storage', () => {
    it('writes and loads a save', () => {
        const storage = new FakeStorage();
        writeSave(SAMPLE, storage);
        expect(loadSave(storage)).toEqual(SAMPLE);
    });

    it('quarantines an unreadable save instead of deleting it', () => {
        const storage = new FakeStorage();
        const bad = '{"version":999,"data":{"garbage":true}}';
        storage.setItem(SAVE_KEY, bad);

        expect(loadSave(storage)).toBeUndefined();
        // The bad save is preserved under the quarantine key...
        expect(storage.getItem(SAVE_QUARANTINE_KEY)).toBe(bad);
        // ...and removed from the live key so it isn't retried forever.
        expect(storage.getItem(SAVE_KEY)).toBeNull();
    });

    it('does not quarantine a valid save', () => {
        const storage = new FakeStorage();
        writeSave(SAMPLE, storage);
        loadSave(storage);
        expect(storage.getItem(SAVE_QUARANTINE_KEY)).toBeNull();
    });

    it('reset clears the live save but leaves quarantine alone', () => {
        const storage = new FakeStorage();
        writeSave(SAMPLE, storage);
        storage.setItem(SAVE_QUARANTINE_KEY, 'old bad save');
        resetSave(storage);
        expect(storage.getItem(SAVE_KEY)).toBeNull();
        expect(storage.getItem(SAVE_QUARANTINE_KEY)).toBe('old bad save');
    });

    it('returns undefined when there is no save', () => {
        expect(loadSave(new FakeStorage())).toBeUndefined();
    });
});
