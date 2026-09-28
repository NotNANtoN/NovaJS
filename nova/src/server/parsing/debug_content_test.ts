import 'jasmine';
import * as path from 'path';
import { getDefaultPlanetData, PlanetData } from 'novadatainterface/PlanetData';
import { OutfitData } from 'novadatainterface/OutfitData';
import { ProjectileWeaponData, WeaponData } from 'novadatainterface/WeaponData';
import { PLANET_BUSTER_OUTFIT_ID, PLANET_BUSTER_WEAPON_ID } from '../../common/debug_content';
import { sameResourceId } from '../../common/resource_id';
import { planetVulnerableTo, PLANET_BUSTER, stellarDamageAmount, weaponHitTypes } from '../../nova_plugin/hit_types';
import { createInitialPlayerState } from '../../nova_plugin/player_state';
import { isPurchaseAvailable, isPurchaseUnlocked } from '../../spaceport/availability';
import { FilesystemData, filenameForId, idForFilename } from './FilesystemData';
import { GameDataAggregator } from './GameDataAggregator';

const objectsPath = path.join(process.env.NOVAJS_ROOT ?? path.resolve(__dirname, '../../../..'),
    'nova', 'objects');

describe('Planet Buster debug content', () => {
    let weapon: WeaponData;
    let outfit: OutfitData;

    beforeAll(async () => {
        const data = new FilesystemData(objectsPath);
        weapon = await data.data.Weapon.get(PLANET_BUSTER_WEAPON_ID);
        outfit = await data.data.Outfit.get(PLANET_BUSTER_OUTFIT_ID);
    });

    it('uses a prefix and a name that never alias retail nova:* ids', () => {
        expect(PLANET_BUSTER_WEAPON_ID.startsWith('debug:')).toBeTrue();
        for (let id = 128; id < 1128; id++) {
            expect(sameResourceId(PLANET_BUSTER_WEAPON_ID, `nova:${id}`)).toBeFalse();
        }
    });

    it('maps namespaced ids to safe file names', () => {
        expect(filenameForId('debug:planetbuster')).toBe('debug%3Aplanetbuster');
        expect(filenameForId('../../etc/passwd')).not.toContain('/');
        expect(idForFilename('debug%3Aplanetbuster')).toBe('debug:planetbuster');
        expect(idForFilename('%E0%A4%A')).toBeUndefined();
    });

    it('parses into a complete planet-type projectile weapon', () => {
        expect(weapon.id).toBe(PLANET_BUSTER_WEAPON_ID);
        expect(weapon.type).toBe('ProjectileWeaponData');
        const projectile = weapon as ProjectileWeaponData;
        expect(projectile.planetType).toBeTrue();
        expect(projectile.ammoType).toBe('unlimited');
        expect(projectile.fireGroup).toBe('secondary');
        expect(projectile.reload).toBeGreaterThan(0);
        expect(projectile.shotDuration).toBeGreaterThan(0);
        expect(projectile.animation.images.baseImage.id).toBeTruthy();
        expect(Array.isArray(projectile.submunitions)).toBeTrue();
        expect(projectile.physics.speed).toBeGreaterThan(0);
    });

    it('hits only the planet layer, which destroyable stellars expose', () => {
        expect([...weaponHitTypes(weapon as ProjectileWeaponData)]).toEqual([PLANET_BUSTER]);
        const earth: PlanetData = { ...getDefaultPlanetData(), id: 'nova:128', strength: 3000 };
        expect(planetVulnerableTo(earth)?.has(PLANET_BUSTER)).toBeTrue();
        expect(planetVulnerableTo({ strength: 0 })).toBeUndefined();
        // Earth (Strength 3000) breaks in one or two hits.
        const perHit = stellarDamageAmount((weapon as ProjectileWeaponData).damage);
        expect(Math.ceil(3000 / perHit)).toBeLessThanOrEqual(2);
    });

    it('is a free launcher for that weapon with a real display weight', () => {
        expect(outfit.id).toBe(PLANET_BUSTER_OUTFIT_ID);
        expect(outfit.weapons).toEqual({ [PLANET_BUSTER_WEAPON_ID]: 1 });
        expect(outfit.price).toBe(0);
        expect(outfit.displayWeight).toBeGreaterThan(0);
        expect(outfit.physics.freeMass).toBe(0);
    });

    it('is never offered by a spaceport, whatever the bits or tech level', () => {
        const state = createInitialPlayerState();
        state.missionBits = state.missionBits.map(() => true);
        const planets: PlanetData[] = [
            { ...getDefaultPlanetData(), id: 'nova:128', techLevel: 10_000, specialTech: [9999] },
            { ...getDefaultPlanetData(), id: 'nova:129', techLevel: undefined },
        ];
        for (const planet of planets) {
            expect(isPurchaseAvailable(outfit, planet, state, new Map(), [0, 0])).toBeFalse();
            expect(isPurchaseUnlocked(outfit, planet, state, new Map(), [0, 0])).toBeFalse();
            state.missionBits[9999] = false;
            expect(isPurchaseAvailable(outfit, planet, state)).toBeFalse();
            state.missionBits[9999] = true;
        }
    });

    it('is withheld from ids, preload data and lookups when debugging is off', async () => {
        const off = new GameDataAggregator([
            new FilesystemData(objectsPath, { excludeIdPrefixes: ['debug:'] })], () => undefined);
        const on = new GameDataAggregator([new FilesystemData(objectsPath)], () => undefined);
        const [offIds, onIds] = await Promise.all([off.ids, on.ids]);
        expect(offIds.Weapon).not.toContain(PLANET_BUSTER_WEAPON_ID);
        expect(offIds.Outfit).not.toContain(PLANET_BUSTER_OUTFIT_ID);
        expect(onIds.Weapon).toContain(PLANET_BUSTER_WEAPON_ID);
        expect(onIds.Outfit).toContain(PLANET_BUSTER_OUTFIT_ID);
        expect((await off.preloadData).Weapon?.[PLANET_BUSTER_WEAPON_ID]).toBeUndefined();
        expect((await on.preloadData).Weapon?.[PLANET_BUSTER_WEAPON_ID]?.name).toBe('Planet Buster');
        expect((await on.preloadData).Outfit?.[PLANET_BUSTER_OUTFIT_ID]?.name).toContain('Planet Buster');
        // A direct lookup falls back to the default weapon, not the real one.
        const withheld = await off.data.Weapon.get(PLANET_BUSTER_WEAPON_ID);
        expect((withheld as ProjectileWeaponData).planetType).not.toBeTrue();
        // Other filesystem content is unaffected.
        expect(offIds.TargetCorners).toContain('targetCorners');
    });
});
