import { Animation } from 'novadatainterface/Animation';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { SystemData } from 'novadatainterface/SystemData';
import { Gettable } from 'novadatainterface/Gettable';
import { SpriteSheetFramesData } from 'novadatainterface/SpriteSheetData';
import { texturesFromFrames } from './textures_from_frames';

export interface WarmFlightAssets {
    gameData: GameDataInterface;
    systemId: string;
    playerShipId?: string;
    extraOutfitIds?: Iterable<string>;
    weaponEntries?: Gettable<unknown>;
    loadFrames?: (frames: SpriteSheetFramesData) => Promise<unknown>;
}

async function tryGet<T>(load: () => Promise<T>): Promise<T | undefined> {
    try {
        return await load();
    } catch {
        return undefined;
    }
}

function collectAnimationSheets(
    animation: Animation | undefined,
    sheets: Set<string>,
): void {
    if (!animation?.images) {
        return;
    }
    for (const image of Object.values(animation.images)) {
        if (image?.id && image.id !== 'default') {
            sheets.add(image.id);
        }
    }
}

/**
 * Load sprite sheets, weapon factories, and explosion records that combat in
 * this system will need, so the first shot is drawn instead of only colliding.
 */
export async function warmFlightAssets({
    gameData,
    systemId,
    playerShipId,
    extraOutfitIds = [],
    weaponEntries,
    loadFrames = texturesFromFrames,
}: WarmFlightAssets): Promise<void> {
    const ships = new Set<string>();
    const outfits = new Set<string>();
    const weapons = new Set<string>();
    const explosions = new Set<string>();
    const sheets = new Set<string>();

    const visitExplosion = async (id: string | null | undefined) => {
        if (!id || explosions.has(id)) {
            return;
        }
        explosions.add(id);
        const explosion = await tryGet(() => gameData.data.Explosion.get(id));
        collectAnimationSheets(explosion?.animation, sheets);
    };

    const visitWeapon = async (id: string) => {
        if (!id || weapons.has(id)) {
            return;
        }
        weapons.add(id);
        const [weapon] = await Promise.all([
            tryGet(() => gameData.data.Weapon.get(id)),
            weaponEntries ? tryGet(() => weaponEntries.get(id)) : undefined,
        ]);
        if (!weapon) {
            return;
        }
        if (weapon.type === 'ProjectileWeaponData') {
            collectAnimationSheets(weapon.animation, sheets);
        }
        if (weapon.type === 'BayWeaponData') {
            await visitShip(weapon.shipID);
        }
        if (weapon.type !== 'BayWeaponData') {
            await visitExplosion(weapon.primaryExplosion);
            await visitExplosion(weapon.secondaryExplosion);
            for (const sub of weapon.submunitions ?? []) {
                await visitWeapon(sub.id);
            }
        }
        if (Array.isArray(weapon.ammoType) && weapon.ammoType[0] === 'outfit') {
            await visitOutfit(weapon.ammoType[1]);
        }
    };

    const visitOutfit = async (id: string) => {
        if (!id || outfits.has(id)) {
            return;
        }
        outfits.add(id);
        const outfit = await tryGet(() => gameData.data.Outfit.get(id));
        if (!outfit) {
            return;
        }
        for (const weaponId of Object.keys(outfit.weapons ?? {})) {
            await visitWeapon(weaponId);
        }
    };

    const visitShip = async (id: string | undefined) => {
        if (!id || ships.has(id)) {
            return;
        }
        ships.add(id);
        const ship = await tryGet(() => gameData.data.Ship.get(id));
        if (!ship) {
            return;
        }
        collectAnimationSheets(ship.animation, sheets);
        await visitExplosion(ship.initialExplosion);
        await visitExplosion(ship.finalExplosion);
        for (const outfitId of Object.keys(ship.outfits ?? {})) {
            await visitOutfit(outfitId);
        }
    };

    const visitSystem = async (system: SystemData | undefined) => {
        if (!system) {
            return;
        }
        for (const planetId of system.planets ?? []) {
            const planet = await tryGet(() => gameData.data.Planet.get(planetId));
            collectAnimationSheets(planet?.animation, sheets);
        }
        for (const npc of system.npcs ?? []) {
            if (npc.fleet) {
                await visitShip(npc.fleet.leader.id);
                for (const escort of npc.fleet.escorts) {
                    await visitShip(escort.id);
                }
            }
            for (const ship of npc.ships ?? []) {
                await visitShip(ship.id);
            }
        }
        const dudes = gameData.data.Dude;
        if (dudes) {
            for (const entry of system.dudes ?? []) {
                const dude = await tryGet(() => dudes.get(entry.id));
                for (const ship of dude?.ships ?? []) {
                    await visitShip(ship.id);
                }
            }
        }
    };

    const system = await tryGet(() => gameData.data.System.get(systemId));
    await visitSystem(system);
    await visitShip(playerShipId);
    for (const outfitId of extraOutfitIds) {
        await visitOutfit(outfitId);
    }

    await Promise.all([...sheets].map(async id => {
        const frames = await tryGet(() =>
            gameData.data.SpriteSheetFrames.get(id));
        if (frames) {
            await tryGet(() => loadFrames(frames));
        }
    }));
}

export function outfitIdsFromState(
    outfits: Iterable<[string, { count: number }]> | undefined,
): string[] {
    if (!outfits) {
        return [];
    }
    return [...outfits]
        .filter(([, state]) => state.count > 0)
        .map(([id]) => id);
}
