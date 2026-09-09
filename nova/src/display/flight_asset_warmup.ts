import { Animation } from 'novadatainterface/Animation';
import { ammoOutfitIds } from 'novadatainterface/WeaponData';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { SystemData } from 'novadatainterface/SystemData';
import { Gettable } from 'novadatainterface/Gettable';
import { SpriteSheetFramesData } from 'novadatainterface/SpriteSheetData';
import { texturesFromFrames } from './textures_from_frames';

export interface WarmFlightProgress {
    loaded: number;
    total: number;
    label: string;
    fraction: number;
}

export interface WarmFlightAssets {
    gameData: GameDataInterface;
    systemId: string;
    playerShipId?: string;
    extraOutfitIds?: Iterable<string>;
    weaponEntries?: Gettable<unknown>;
    loadFrames?: (frames: SpriteSheetFramesData) => Promise<unknown>;
    loadSound?: (id: string) => Promise<unknown>;
    onProgress?: (progress: WarmFlightProgress) => void;
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
    loadSound,
    onProgress,
}: WarmFlightAssets): Promise<void> {
    const ships = new Set<string>();
    const outfits = new Set<string>();
    const weapons = new Set<string>();
    const explosions = new Set<string>();
    const sheets = new Set<string>();
    const sounds = new Set<string>();

    onProgress?.({
        loaded: 0,
        total: 1,
        label: 'Scanning system catalog...',
        fraction: 0,
    });

    const visitExplosion = async (id: string | null | undefined) => {
        if (!id || explosions.has(id)) {
            return;
        }
        explosions.add(id);
        const explosion = await tryGet(() => gameData.data.Explosion.get(id));
        collectAnimationSheets(explosion?.animation, sheets);
        if (explosion?.sound) sounds.add(explosion.sound);
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
        if (weapon.sound) sounds.add(weapon.sound);
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
        for (const id of ammoOutfitIds(weapon.ammoType)) {
            await visitOutfit(id);
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

    // The destination is required, unlike optional references in retail data.
    const system = await gameData.data.System.get(systemId);
    await visitSystem(system);
    await visitShip(playerShipId);
    for (const outfitId of extraOutfitIds) {
        await visitOutfit(outfitId);
    }

    // Preload all weapon entries and explosion sprite sheets in the game so any
    // ship jumping in (such as a Thunderbird with lances or cruisers with heavy beams)
    // has its WeaponEntries initialized and its combat textures cached immediately.
    const allIds = await tryGet(() => gameData.ids);
    if (allIds?.Weapon) {
        await Promise.all(allIds.Weapon.map(id => visitWeapon(id)));
    }
    if (allIds?.Explosion) {
        await Promise.all(allIds.Explosion.map(id => visitExplosion(id)));
    }
    if (allIds?.Ship) {
        await Promise.all(allIds.Ship.map(id => visitShip(id)));
    }

    if (allIds?.Asteroid && gameData.data.Asteroid) {
        await Promise.all(allIds.Asteroid.map(async id => {
            const asteroid = await tryGet(() => gameData.data.Asteroid!.get(id));
            collectAnimationSheets(asteroid?.animation, sheets);
            collectAnimationSheets(asteroid?.yieldAnimation, sheets);
        }));
    }

    // Atlas downloads bypass GameData's metadata queue. Bound them here so a
    // cold cache does not flood a remote connection with hundreds of requests.
    const pendingSheets = [...sheets].values();
    const sheetCount = sheets.size;
    const soundCount = loadSound ? sounds.size : 0;
    const totalItems = sheetCount + soundCount;
    let completedItems = 0;

    const reportProgress = (type: 'textures' | 'audio') => {
        completedItems++;
        const fraction = totalItems > 0 ? Math.min(1, completedItems / totalItems) : 1;
        const label = type === 'textures'
            ? `Loading textures (${completedItems}/${totalItems})`
            : `Loading audio (${completedItems}/${totalItems})`;
        onProgress?.({
            loaded: completedItems,
            total: totalItems,
            label,
            fraction,
        });
    };

    if (totalItems === 0) {
        onProgress?.({ loaded: 0, total: 0, label: 'Assets ready', fraction: 1 });
    }

    const failures: string[] = [];
    await Promise.all(Array.from({ length: 8 }, async () => {
        for (const id of pendingSheets) {
            try {
                // Collision polygons are a separate asset from artwork. Fetch
                // them before flight too, so a visible first volley can hit.
                const [frames] = await Promise.all([
                    gameData.data.SpriteSheetFrames.get(id),
                    gameData.data.SpriteSheet?.get(id),
                ]);
                await loadFrames(frames);
                reportProgress('textures');
            } catch (error) {
                failures.push(id);
                reportProgress('textures');
                console.warn(`Failed to preload flight sprite sheet ${id}`, error);
            }
        }
    }));
    if (loadSound) {
        const pendingSounds = sounds.values();
        await Promise.all(Array.from({ length: 8 }, async () => {
            for (const id of pendingSounds) {
                // Browsers may disallow audio until a user gesture. Missing audio
                // must not make an otherwise playable scene inaccessible.
                await tryGet(() => loadSound(id));
                reportProgress('audio');
            }
        }));
    }
    if (failures.length) {
        const detail = failures.slice(0, 5).join(', ')
            + (failures.length > 5 ? ` and ${failures.length - 5} more` : '');
        throw new Error(`Could not load flight artwork (${detail}). Please retry entering the game.`);
    }
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
