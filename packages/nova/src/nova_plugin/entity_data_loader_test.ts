import 'jasmine';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { loadShipGameData, loadWeaponGameData } from './entity_data_loader.js';

function fakeGettable<T>(items: Record<string, T>) {
    return {
        get: async (id: string) => items[id],
        getCached: (id: string) => items[id],
    };
}

const ANIMATION = { images: { baseImage: { id: 'sheet' } } };

function bayShip(bayWeapon: string) {
    return {
        animation: ANIMATION,
        outfits: { [`outfit ${bayWeapon}`]: 1 },
    };
}

/**
 * Three ships whose bays carry each other in a cycle (A carries B,
 * B carries C, C carries A), plus a pair of weapons whose submunitions
 * are mutually recursive. Loading must terminate.
 */
function makeCyclicGameData(): SimulationGameDataInterface {
    return {
        data: {
            Ship: fakeGettable({
                A: {
                    animation: ANIMATION,
                    outfits: { 'outfit bay B': 1, 'outfit subX': 1 },
                },
                B: bayShip('bay C'),
                C: bayShip('bay A'),
            }),
            Outfit: fakeGettable({
                'outfit bay B': { weapons: { 'bay B': 1 } },
                'outfit bay C': { weapons: { 'bay C': 1 } },
                'outfit bay A': { weapons: { 'bay A': 1 } },
                'outfit subX': { weapons: { 'subX': 1 } },
            }),
            Weapon: fakeGettable({
                'bay A': { type: 'BayWeaponData', shipID: 'A' },
                'bay B': { type: 'BayWeaponData', shipID: 'B' },
                'bay C': { type: 'BayWeaponData', shipID: 'C' },
                subX: {
                    type: 'ProjectileWeaponData',
                    animation: ANIMATION,
                    submunitions: [{ id: 'subY' }],
                },
                subY: {
                    type: 'ProjectileWeaponData',
                    animation: ANIMATION,
                    submunitions: [{ id: 'subX' }],
                },
            }),
            SpriteSheet: fakeGettable({ sheet: { hulls: [] } }),
        },
    } as never;
}

describe('entity data loader', () => {
    it('terminates on mutually recursive carried ships', async () => {
        const weaponIds = await loadShipGameData(makeCyclicGameData(), 'A');
        expect([...weaponIds].sort()).toEqual(['bay A', 'bay B', 'bay C', 'subX', 'subY']);
    }, 5_000);

    it('terminates on mutually recursive submunitions', async () => {
        const weaponIds = await loadWeaponGameData(makeCyclicGameData(), 'subX');
        expect([...weaponIds].sort()).toEqual(['subX', 'subY']);
    }, 5_000);
});
