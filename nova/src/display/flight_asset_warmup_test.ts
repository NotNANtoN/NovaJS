import 'jasmine';
import { getDefaultAnimation } from 'novadatainterface/Animation';
import { getDefaultOutfitData } from 'novadatainterface/OutfitData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import {
    getDefaultExplosionData,
} from 'novadatainterface/ExplosionData';
import {
    getDefaultProjectileWeaponData,
} from 'novadatainterface/WeaponData';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { Gettable } from 'novadatainterface/Gettable';
import {
    outfitIdsFromState,
    warmFlightAssets,
} from './flight_asset_warmup';

function animationWith(id: string) {
    const animation = getDefaultAnimation();
    animation.images.baseImage = {
        ...animation.images.baseImage,
        id,
    };
    return animation;
}

describe('warmFlightAssets', () => {
    it('loads projectile, explosion, and NPC hull sheets for the system', async () => {
        const loaded: string[] = [];
        const ships = new Map([
            ['nova:shuttle', {
                ...getDefaultShipData(),
                id: 'nova:shuttle',
                outfits: { 'nova:gun': 1 },
                animation: animationWith('sheet:shuttle'),
                initialExplosion: 'nova:boom',
                finalExplosion: null,
            }],
            ['nova:leviathan', {
                ...getDefaultShipData(),
                id: 'nova:leviathan',
                outfits: { 'nova:cannon': 1 },
                animation: animationWith('sheet:leviathan'),
                initialExplosion: null,
                finalExplosion: null,
            }],
        ]);
        const outfits = new Map([
            ['nova:gun', {
                ...getDefaultOutfitData(),
                weapons: { 'nova:blaster': 1 },
            }],
            ['nova:cannon', {
                ...getDefaultOutfitData(),
                weapons: { 'nova:heavy': 1 },
            }],
        ]);
        const weapons = new Map([
            ['nova:blaster', {
                ...getDefaultProjectileWeaponData(),
                type: 'ProjectileWeaponData' as const,
                animation: animationWith('sheet:blaster'),
                primaryExplosion: 'nova:impact',
                secondaryExplosion: null,
                submunitions: [],
            }],
            ['nova:heavy', {
                ...getDefaultProjectileWeaponData(),
                type: 'ProjectileWeaponData' as const,
                animation: animationWith('sheet:heavy'),
                primaryExplosion: null,
                secondaryExplosion: null,
                submunitions: [],
            }],
        ]);
        const explosions = new Map([
            ['nova:boom', {
                ...getDefaultExplosionData(),
                animation: animationWith('sheet:boom'),
            }],
            ['nova:impact', {
                ...getDefaultExplosionData(),
                animation: animationWith('sheet:impact'),
            }],
        ]);
        const frames = new Gettable(async (id: string) => {
            loaded.push(id);
            return {
                frames: {},
                meta: { image: `${id}.png` },
            } as never;
        });
        const weaponEntriesLoaded: string[] = [];
        const weaponEntries = new Gettable(async (id: string) => {
            weaponEntriesLoaded.push(id);
            return { id };
        });
        const gameData = {
            data: {
                Ship: { get: async (id: string) => ships.get(id) },
                Outfit: { get: async (id: string) => outfits.get(id) },
                Weapon: { get: async (id: string) => weapons.get(id) },
                Explosion: { get: async (id: string) => explosions.get(id) },
                Planet: { get: async () => undefined },
                System: {
                    get: async () => ({
                        ...getDefaultSystemData(),
                        npcs: [{
                            id: 'nova:fleet',
                            weight: 1,
                            government: -1,
                            ships: [{ id: 'nova:leviathan', weight: 1 }],
                        }],
                    }),
                },
                SpriteSheetFrames: frames,
            },
        } as unknown as GameDataInterface;

        await warmFlightAssets({
            gameData,
            systemId: 'nova:130',
            playerShipId: 'nova:shuttle',
            extraOutfitIds: ['nova:gun'],
            weaponEntries,
            loadFrames: async () => undefined,
        });

        expect(loaded.sort()).toEqual([
            'sheet:blaster',
            'sheet:boom',
            'sheet:heavy',
            'sheet:impact',
            'sheet:leviathan',
            'sheet:shuttle',
        ].sort());
        expect(weaponEntriesLoaded.sort()).toEqual(['nova:blaster', 'nova:heavy']);
    });

    it('preloads all weapons and explosions when gameData.ids is available', async () => {
        const loaded: string[] = [];
        const weaponEntriesLoaded: string[] = [];
        const weapons = new Map([
            ['nova:lance', {
                ...getDefaultProjectileWeaponData(),
                type: 'ProjectileWeaponData' as const,
                animation: animationWith('sheet:lance'),
                primaryExplosion: 'nova:lance_spark',
                secondaryExplosion: null,
                submunitions: [],
            }],
        ]);
        const explosions = new Map([
            ['nova:lance_spark', {
                ...getDefaultExplosionData(),
                animation: animationWith('sheet:lance_spark'),
            }],
        ]);
        const frames = new Gettable(async (id: string) => {
            loaded.push(id);
            return {
                frames: {},
                meta: { image: `${id}.png` },
            } as never;
        });
        const weaponEntries = new Gettable(async (id: string) => {
            weaponEntriesLoaded.push(id);
            return { id };
        });
        const gameData = {
            ids: Promise.resolve({
                Weapon: ['nova:lance'],
                Explosion: ['nova:lance_spark'],
                Ship: [],
            } as never),
            data: {
                Ship: { get: async () => undefined },
                Outfit: { get: async () => undefined },
                Weapon: { get: async (id: string) => weapons.get(id) },
                Explosion: { get: async (id: string) => explosions.get(id) },
                Planet: { get: async () => undefined },
                System: {
                    get: async () => getDefaultSystemData(),
                },
                SpriteSheetFrames: frames,
            },
        } as unknown as GameDataInterface;

        await warmFlightAssets({
            gameData,
            systemId: 'nova:130',
            weaponEntries,
            loadFrames: async () => undefined,
        });

        expect(loaded.sort()).toEqual(['sheet:lance', 'sheet:lance_spark']);
        expect(weaponEntriesLoaded).toEqual(['nova:lance']);
    });

    it('reads installed outfit ids from player state', () => {
        expect(outfitIdsFromState(new Map([
            ['nova:gun', { count: 2 }],
            ['nova:empty', { count: 0 }],
        ]))).toEqual(['nova:gun']);
    });
});
