import 'jasmine';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { loadPlayerContribute } from './player_contribute';

function gettable(entries: Record<string, { contribute?: number[] }>) {
    return {
        get: async (id: string) => {
            const found = entries[id];
            if (!found) throw new Error(`missing ${id}`);
            return found;
        },
    };
}

function gameData(data: Record<string, unknown>): GameDataInterface {
    return { data, ids: Promise.resolve({}) } as unknown as GameDataInterface;
}

describe('loadPlayerContribute', () => {
    it('ORs ship, held outfits, active ranks and active crons', async () => {
        const data = gameData({
            Ship: gettable({ 'nova:128': { contribute: [0, 0x1] } }),
            Outfit: gettable({
                'nova:150': { contribute: [0x10, 0] },
                'nova:151': { contribute: [0x20, 0] },
            }),
            Rank: gettable({ 'nova:130': { contribute: [0, 0x100] } }),
            Cron: gettable({ 'nova:200': { contribute: [0x4, 0] } }),
        });
        const contribute = await loadPlayerContribute(data, {
            shipId: 'nova:128',
            outfits: new Map([
                ['nova:150', { count: 1 }],
                ['nova:151', { count: 0 }],
            ]),
            activeRanks: [130],
            activeCrons: ['nova:200'],
        });
        expect(contribute).toEqual([0x14, 0x101]);
    });

    it('tolerates missing gettables and unknown ids', async () => {
        const data = gameData({
            Ship: gettable({ 'nova:128': { contribute: [0, 0x11] } }),
            Outfit: gettable({}),
        });
        const contribute = await loadPlayerContribute(data, {
            shipId: 'nova:128',
            outfits: new Map([['nova:999', { count: 2 }]]),
            activeRanks: [131],
            activeCrons: ['nova:201'],
        });
        expect(contribute).toEqual([0, 0x11]);
        expect(await loadPlayerContribute(gameData({}), {
            shipId: undefined, outfits: undefined,
        })).toEqual([0, 0]);
    });
});
