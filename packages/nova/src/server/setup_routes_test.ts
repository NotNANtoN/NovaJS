import 'jasmine';
import { Gettable } from 'novadatainterface/gettable';
import { GameDataInterface } from 'novadatainterface/game_data_interface';
import { resolveBatch, BatchResponse } from './setup_routes.js';

// A minimal GameDataInterface whose gettables are backed by the maps
// passed in. A `null` value for an id means "throw when fetched".
function makeGameData(tables: {
    [dataType: string]: { [id: string]: unknown | null };
}): GameDataInterface {
    const data: Record<string, Gettable<unknown>> = {};
    for (const [type, entries] of Object.entries(tables)) {
        data[type] = new Gettable<unknown>(async (id: string) => {
            if (!(id in entries)) {
                throw new Error(`No ${type} with id ${id}`);
            }
            const val = entries[id];
            if (val === null) {
                throw new Error(`Boom loading ${type}:${id}`);
            }
            return val;
        });
    }
    return {
        data: data as unknown as GameDataInterface['data'],
        ids: Promise.resolve({} as GameDataInterface['ids'] extends Promise<infer I> ? I : never),
    } as GameDataInterface;
}

function entry(resp: BatchResponse, type: string, id: string) {
    return resp[type][id];
}

describe('resolveBatch', () => {
    it('resolves multiple ids across multiple types in one call', async () => {
        const gameData = makeGameData({
            Ship: { 'a': { name: 'ShipA' }, 'b': { name: 'ShipB' } },
            Outfit: { 'x': { name: 'OutfitX' } },
        });

        const resp = await resolveBatch(gameData, {
            Ship: ['a', 'b'],
            Outfit: ['x'],
        });

        expect(entry(resp, 'Ship', 'a')).toEqual({ data: { name: 'ShipA' } });
        expect(entry(resp, 'Ship', 'b')).toEqual({ data: { name: 'ShipB' } });
        expect(entry(resp, 'Outfit', 'x')).toEqual({ data: { name: 'OutfitX' } });
    });

    it('reports a missing id as an error without failing the batch', async () => {
        const gameData = makeGameData({
            Ship: { 'present': { name: 'Here' } },
        });

        const resp = await resolveBatch(gameData, {
            Ship: ['present', 'absent'],
        });

        expect(entry(resp, 'Ship', 'present')).toEqual({ data: { name: 'Here' } });
        const absent = entry(resp, 'Ship', 'absent');
        expect('error' in absent).toBe(true);
        if ('error' in absent) {
            expect(absent.error).toContain('absent');
        }
    });

    it('reports a per-id load failure as an error without failing siblings', async () => {
        const gameData = makeGameData({
            Ship: { 'ok': { name: 'Ok' }, 'boom': null },
        });

        const resp = await resolveBatch(gameData, {
            Ship: ['ok', 'boom'],
        });

        expect(entry(resp, 'Ship', 'ok')).toEqual({ data: { name: 'Ok' } });
        const boom = entry(resp, 'Ship', 'boom');
        expect('error' in boom).toBe(true);
    });

    it('marks every id of an unknown data type as an error', async () => {
        const gameData = makeGameData({ Ship: { 'a': {} } });

        const resp = await resolveBatch(gameData, {
            Nonsense: ['one', 'two'],
        });

        for (const id of ['one', 'two']) {
            const e = entry(resp, 'Nonsense', id);
            expect('error' in e).toBe(true);
            if ('error' in e) {
                expect(e.error).toContain('Unknown data type');
            }
        }
    });

    it('rejects binary (ArrayBuffer) results as errors', async () => {
        const gameData = makeGameData({
            SpriteSheetImage: { 'img': new ArrayBuffer(8) },
        });

        const resp = await resolveBatch(gameData, {
            SpriteSheetImage: ['img'],
        });

        const e = entry(resp, 'SpriteSheetImage', 'img');
        expect('error' in e).toBe(true);
        if ('error' in e) {
            expect(e.error).toContain('Binary');
        }
    });

    it('handles an empty id list for a type', async () => {
        const gameData = makeGameData({ Ship: { 'a': {} } });
        const resp = await resolveBatch(gameData, { Ship: [] });
        expect(resp.Ship).toEqual({});
    });

    it('isolates errors between types in the same batch', async () => {
        const gameData = makeGameData({
            Ship: { 'good': { ok: true } },
            Outfit: {},
        });

        const resp = await resolveBatch(gameData, {
            Ship: ['good'],
            Outfit: ['missing'],
            Bogus: ['z'],
        });

        expect(entry(resp, 'Ship', 'good')).toEqual({ data: { ok: true } });
        expect('error' in entry(resp, 'Outfit', 'missing')).toBe(true);
        expect('error' in entry(resp, 'Bogus', 'z')).toBe(true);
    });
});
