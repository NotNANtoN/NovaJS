import { Entity } from "nova_ecs/entity";
import { World } from "nova_ecs/world";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { WeaponEntries } from "./fire_weapon_plugin.js";
import { SimulationGameDataResource } from "./game_data_resource.js";
import { PlanetComponent } from "./planet_plugin.js";
import { ShipComponent } from "./ship_plugin.js";

/**
 * Loads the transitive closure of game data an entity needs to be
 * simulated *synchronously*: the simulation must never wait for data
 * mid-step, because the tick at which data arrives would vary between
 * runs and peers, breaking determinism and rollback resimulation.
 *
 * A ship's closure includes everything its future spawns need the same
 * tick they are created: its outfits' weapons, those weapons'
 * projectiles/submunition chains and their hurtbox sprite sheets, and
 * bay fighter ship classes (recursively).
 *
 * Entities enter the simulation only after their closure is loaded
 * ("stage, load, then insert"); the insertion tick is an input, so it
 * is allowed to vary.
 */
export async function loadShipGameData(gameData: SimulationGameDataInterface,
    shipId: string, weaponIds = new Set<string>(),
    seenShips = new Set<string>()): Promise<Set<string>> {
    if (seenShips.has(shipId)) {
        return weaponIds;
    }
    seenShips.add(shipId);

    const ship = await gameData.data.Ship.get(shipId);
    await loadAnimationGameData(gameData, ship.animation);
    for (const outfitId of Object.keys(ship.outfits)) {
        const outfit = await gameData.data.Outfit.get(outfitId);
        if (!outfit?.weapons) {
            continue;
        }
        for (const weaponId of Object.keys(outfit.weapons)) {
            await loadWeaponGameData(gameData, weaponId, weaponIds, seenShips);
        }
    }
    return weaponIds;
}

export async function loadWeaponGameData(gameData: SimulationGameDataInterface,
    weaponId: string, weaponIds = new Set<string>(),
    seenShips = new Set<string>()): Promise<Set<string>> {
    if (weaponIds.has(weaponId)) {
        return weaponIds;
    }
    weaponIds.add(weaponId);

    const weapon = await gameData.data.Weapon.get(weaponId);
    if (!weapon) {
        return weaponIds;
    }
    if ('animation' in weapon && weapon.animation) {
        // Projectile hurtboxes are built from the sprite sheet.
        await loadAnimationGameData(gameData, weapon.animation);
    }
    if ('submunitions' in weapon) {
        for (const sub of weapon.submunitions) {
            await loadWeaponGameData(gameData, sub.id, weaponIds, seenShips);
        }
    }
    if (weapon.type === 'BayWeaponData') {
        await loadShipGameData(gameData, weapon.shipID, weaponIds, seenShips);
    }
    return weaponIds;
}

async function loadAnimationGameData(gameData: SimulationGameDataInterface,
    animation: { images: { baseImage: { id: string } } }) {
    try {
        await gameData.data.SpriteSheet.get(animation.images.baseImage.id);
    } catch (e) {
        console.warn(`Failed to load sprite sheet for hull:`, e);
    }
}

/**
 * Loads everything an entity needs before it is inserted into a
 * simulation world, and primes the world's WeaponEntries so weapons can
 * fire synchronously.
 */
export async function loadEntityGameData(world: World, entity: Entity) {
    const ship = entity.components.get(ShipComponent);
    const planet = entity.components.get(PlanetComponent);
    if (!ship && !planet) {
        return;
    }
    const gameData = world.resources.get(SimulationGameDataResource);
    if (!gameData) {
        throw new Error('Expected SimulationGameDataResource to exist');
    }

    const weaponIds = new Set<string>();
    if (ship) {
        await loadShipGameData(gameData, ship.id, weaponIds);
    }
    if (planet) {
        await gameData.data.Planet.get(planet.id);
    }

    // Prime the lazily-constructed weapon entries so the first shot of
    // each weapon does not depend on when its entry finished building.
    const weaponEntries = world.resources.get(WeaponEntries);
    if (weaponEntries) {
        await Promise.all([...weaponIds].map(id => weaponEntries.get(id)));
    }
}
