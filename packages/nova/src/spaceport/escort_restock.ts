import { OutfitData } from 'novadatainterface/outfit_data';
import { WeaponData } from 'novadatainterface/weapon_data';
import { Entity } from 'nova_ecs/entity';
import { FuelComponent } from '../nova_plugin/health_plugin.js';
import {
    OutfitsState, OutfitsStateComponent,
} from '../nova_plugin/outfit_plugin.js';

/**
 * ============================================================================
 * Escorts rearm and refuel when they land with you
 * ============================================================================
 *
 * An escort that puts down on the same rock as its player comes back up
 * with full fuel and full magazines, FREE OF CHARGE.
 *
 * WHY FREE, when the player's own refuel is PAID (spaceport.ts charges for
 * it). Matthew's ruling: the hire fee is the whole commercial relationship
 * — an escort pilot maintains their own ship out of it, so their upkeep is
 * not itemized back to the player. Charging for it would also need a
 * per-escort price UI that the original never shows. Note this is
 * deliberately NOT symmetric with the player, and the asymmetry is the
 * design, not an oversight.
 *
 * WHAT IS RESTOCKED: fuel (FuelComponent.current -> max) and ammunition
 * (every owned outfit with an `ammoFor` goes back to capacity). Bay
 * fighters ARE ammo outfits in this data model, so a carrier escort's
 * fighter complement is restored by the same rule, with no special case.
 *
 * WHAT IS NOT: armor and shields. Those regenerate on their own (or are
 * repaired by boarding a disabled escort), and Matthew scoped this nit to
 * ammo and energy only — a landing must not be a free hull repair.
 *
 * WHERE IT RUNS: on the LANDED roster as it is consumed (browser.ts), not
 * on the jump roster. An escort that merely rode along through hyperspace
 * never touched a pad and gets nothing. Capture time would be the other
 * candidate single point, but by consumption time the two rosters have
 * already been concatenated in one place (jumpTo), so applying it to the
 * landed half at each drain site is what keeps the two cases apart.
 */

/** The data lookups the restock needs, narrowed for testability. */
export interface RestockGameData {
    getOutfit(id: string): Promise<OutfitData | undefined>;
    getWeapon(id: string): Promise<WeaponData | undefined>;
}

/**
 * The most of `outfit` this ship can hold, mirroring the outfitter's
 * ammoCapacity/effectiveMax pair (outfitter_rules.ts) so a restocked
 * escort ends up exactly where a player buying to the cap would:
 *
 *  - Ammo whose weapon has MaxAmmo > 0 is capped at MaxAmmo per owned
 *    launcher instance (summed over every launcher outfit that fires it,
 *    weighted by how many of each the ship carries).
 *  - Ammo whose weapon has MaxAmmo <= 0 defers to the outfit's own Max
 *    field, multiplied by any owned "increases max" items pointing at it.
 *  - A Max of <= 0 there means UNLIMITED, which has no ceiling to fill to,
 *    so such an outfit is left at whatever count it already had.
 *
 * Returns undefined when there is no finite ceiling.
 */
async function ammoCeiling(outfit: OutfitData, owned: OutfitsState,
    ownedData: ReadonlyMap<string, OutfitData>,
    gameData: RestockGameData): Promise<number | undefined> {
    const byOutfitMax = () => {
        if (outfit.max <= 0) {
            return undefined; // Unlimited: nothing to fill to.
        }
        let multiplier = 0;
        for (const [id, data] of ownedData) {
            if (data.increasesMax === outfit.id) {
                multiplier += owned.get(id)?.count ?? 0;
            }
        }
        return outfit.max * Math.max(1, multiplier);
    };

    if (!outfit.ammoFor) {
        return undefined;
    }
    const suppliedWeapon = await gameData.getWeapon(outfit.ammoFor);
    if (!suppliedWeapon || suppliedWeapon.maxAmmo <= 0) {
        return byOutfitMax();
    }

    let capacity = 0;
    for (const [id, data] of ownedData) {
        const outfitCount = owned.get(id)?.count ?? 0;
        if (outfitCount <= 0) {
            continue;
        }
        for (const [weaponId, weaponCount] of Object.entries(data.weapons)) {
            const launcher = await gameData.getWeapon(weaponId);
            if (!launcher || launcher.ammoType === 'unlimited'
                || launcher.ammoType[0] !== 'weapon'
                || launcher.ammoType[1] !== outfit.ammoFor) {
                continue;
            }
            if (launcher.maxAmmo <= 0) {
                // This launcher defers to the outfit's Max field, exactly
                // as the outfitter's ammoCapacity bails out here.
                return byOutfitMax();
            }
            capacity += launcher.maxAmmo * weaponCount * outfitCount;
        }
    }
    return capacity;
}

/**
 * Refuels and rearms one carried escort entity in place. Safe to call on
 * an entity with no fuel stat or no outfits — it simply does less.
 *
 * SEAM: a bay fighter that landed still deployed (it is on the roster in
 * its own right — see deployedFightersBySource in landed_escorts.ts) is
 * NOT subtracted from its carrier's restocked bay capacity, so such a
 * carrier can briefly hold capacity + the already-launched fighter. The
 * outfitter models this properly through its deployedCounts hook; wiring
 * that same hook through the escort restock is left for when bay
 * accounting for escorts is done as a whole.
 */
export async function restockEscortEntity(entity: Entity,
    gameData: RestockGameData): Promise<void> {
    const fuel = entity.components.get(FuelComponent);
    if (fuel) {
        fuel.current = fuel.max;
    }

    const owned = entity.components.get(OutfitsStateComponent);
    if (!owned || owned.size === 0) {
        return;
    }
    // Resolve every owned outfit once: the ceiling for any one ammo type
    // depends on the whole loadout (which launchers are aboard).
    const ownedData = new Map<string, OutfitData>();
    for (const id of owned.keys()) {
        const data = await gameData.getOutfit(id);
        if (data) {
            ownedData.set(id, data);
        }
    }

    for (const [id, data] of ownedData) {
        if (!data.ammoFor) {
            continue;
        }
        const ceiling = await ammoCeiling(data, owned, ownedData, gameData);
        if (ceiling === undefined) {
            continue;
        }
        const state = owned.get(id);
        if (state && state.count < ceiling) {
            // Never trims an overfull magazine — a restock tops up.
            state.count = ceiling;
        }
    }
}

/** Refuels and rearms a whole landed batch, in roster order. */
export async function restockCarriedEscorts(
    escorts: readonly { entity: Entity }[],
    gameData: RestockGameData): Promise<void> {
    for (const { entity } of escorts) {
        await restockEscortEntity(entity, gameData);
    }
}
