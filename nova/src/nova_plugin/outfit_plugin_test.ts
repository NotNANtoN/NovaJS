import 'jasmine';
import { getDefaultShipPhysics, ShipPhysics } from 'novadatainterface/ShipData';
import { getDefaultOutfitData, OutfitData } from 'novadatainterface/OutfitData';
import { applyOutfitPhysics } from './outfit_plugin';

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
});
