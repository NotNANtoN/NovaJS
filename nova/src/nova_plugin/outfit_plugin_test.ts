import 'jasmine';
import { getDefaultShipPhysics, ShipPhysics } from 'novadatainterface/ShipData';
import { getDefaultOutfitData, OutfitData } from 'novadatainterface/OutfitData';
import { applyOutfitPhysics, loadOutfitWeapons } from './outfit_plugin';
import { createDraft, finishDraft, enableMapSet } from 'immer';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';

describe('async outfit weapon snapshots', () => {
    it('does not read count, map, or firing drafts after a catalog await', async () => {
        enableMapSet();
        const outfits = createDraft(new Map([['launcher', { count: 2 }], ['second', { count: 1 }]]));
        const previous = createDraft(new Map([['weapon', { count: 2, firing: true }]]));
        let release!: (value: OutfitData) => void;
        const first = new Promise<OutfitData>(resolve => { release = resolve; });
        const gameData = { data: { Outfit: { get: (id: string) => id === 'launcher'
            ? first : Promise.resolve({ ...getDefaultOutfitData(), weapons: { weapon: 1 } }) } } } as unknown as GameDataInterface;
        const pending = loadOutfitWeapons(outfits, gameData, previous);
        finishDraft(outfits);
        finishDraft(previous);
        release({ ...getDefaultOutfitData(), weapons: { weapon: 1 } });
        const result = await pending;
        expect(result.get('weapon')).toEqual({ count: 3, firing: true });
    });
});

describe('applyOutfitPhysics', () => {
    it('correctly reduces freeMass and increases ship mass when outfits are installed', () => {
        const basePhysics: ShipPhysics = {
            ...getDefaultShipPhysics(),
            freeMass: 100,
            mass: 200,
            shield: 100,
            acceleration: 300,
        };

        const shieldOutfit: OutfitData = {
            ...getDefaultOutfitData(),
            physics: {
                freeMass: 10, // 10 tons of outfit mass
                shield: 50,
            },
        };

        const engineOutfit: OutfitData = {
            ...getDefaultOutfitData(),
            physics: {
                freeMass: 15, // 15 tons of outfit mass
                acceleration: 60,
            },
        };

        const outfits: Array<readonly [OutfitData, number]> = [
            [shieldOutfit, 2], // 2 * 10 = 20 tons
            [engineOutfit, 1], // 1 * 15 = 15 tons
        ];

        const result = applyOutfitPhysics(basePhysics, outfits);

        expect(result.freeMass).toBe(100 - 35); // 65
        expect(result.mass).toBe(200 + 35); // 235
        expect(result.shield).toBe(100 + 100); // 200
        expect(result.acceleration).toBe(300 + 60); // 360
    });

    it('applies cargo expansions and shield/armor recharge stacking', () => {
        const basePhysics: ShipPhysics = {
            ...getDefaultShipPhysics(),
            freeCargo: 20,
            shieldRecharge: 5,
            armorRecharge: 0,
        };

        const cargoOutfit: OutfitData = {
            ...getDefaultOutfitData(),
            physics: {
                freeMass: 5,
                freeCargo: 10,
            },
        };

        const shieldRegenOutfit: OutfitData = {
            ...getDefaultOutfitData(),
            physics: {
                freeMass: 8,
                shieldRecharge: 15,
            },
        };

        const result = applyOutfitPhysics(basePhysics, [
            [cargoOutfit, 2],
            [shieldRegenOutfit, 1],
        ]);

        expect(result.freeCargo).toBe(20 + 20);
        expect(result.shieldRecharge).toBe(5 + 15);
    });
});
