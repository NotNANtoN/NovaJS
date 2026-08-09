/**
 * Counting outfits the player owns but that are not physically aboard
 * while docked — today, fighters still flying after their carrier
 * landed.
 *
 * Why this exists (Matthew's rule): a launched fighter has already been
 * removed from the carrier's OutfitsStateComponent (weapon_plugin's
 * consumeAmmo spent it), so landing with fighters out would otherwise
 * look to the outfitter like free magazine space, and the player could
 * buy past the bay's capacity. Every deployed fighter therefore still
 * counts against both the outfit's Max and its launcher's ammo
 * capacity.
 *
 * Deliberately NOT folded in: free mass, cargo, hardpoints, and
 * Contribute flags all keep reading only what is physically installed
 * (outfitter_rules' ownedOutfits). A deployed fighter's tonnage really
 * is off the ship, so a player CAN currently buy into mass that a
 * returning fighter then wants back. Widening ownedOutfits would change
 * every one of those five rules at once, so it is left alone here.
 *
 * ---------------------------------------------------------------------
 * EXTENSION SEAM for the landed-escort roster
 * ---------------------------------------------------------------------
 * `DeployedOutfitCounts` is a provider function, not a value, precisely
 * so more sources of "owned but not aboard" can be added without
 * touching outfitter_rules or the Outfitter menu. To add a source
 * (e.g. hired escorts that are still in the system when the player
 * lands, each of which cost an outfit-like slot), write another
 * counting function beside `countDeployedFighters` and compose the two
 * with `mergeDeployedCounts` at the wiring site in
 * display/spaceport_plugin.ts. Nothing downstream needs to know how
 * many sources there are.
 */
import { OutfitData } from 'novadatainterface/outfit_data';
import { Entity } from 'nova_ecs/entity';
import { BayFighterComponent } from '../nova_plugin/bay_plugin.js';
import { OwnerComponent, SourceComponent } from '../nova_plugin/fire_weapon_plugin.js';

/**
 * Outfit global id -> how many units of it the player owns that are not
 * currently installed on the docked ship.
 *
 * Resolved lazily (a function, not a map) because the display world
 * keeps stepping and syncing while the player is docked: a fighter can
 * still be shot down mid-visit, and the outfitter re-reads the counts
 * on every trade-state refresh.
 *
 * The argument is the set of outfit ids the player owns, which is how a
 * fighter is attributed to a specific ammo outfit — see
 * `countDeployedFighters`.
 */
export type DeployedOutfitCounts =
    (ownedOutfitIds: Iterable<string>) => ReadonlyMap<string, number>;

/** Sums several deployed-count providers into one. */
export function mergeDeployedCounts(...providers: DeployedOutfitCounts[]):
    DeployedOutfitCounts {
    return ownedOutfitIds => {
        const ids = [...ownedOutfitIds];
        const total = new Map<string, number>();
        for (const provider of providers) {
            for (const [id, count] of provider(ids)) {
                total.set(id, (total.get(id) ?? 0) + count);
            }
        }
        return total;
    };
}

/**
 * Walks an entity's owner chain to the ship that ultimately launched or
 * hired it. Bounded so a cycle in replicated state cannot hang the
 * outfitter.
 */
function ownerRoot(uuid: string, entities: ReadonlyMap<string, Entity>,
    limit = 8): string {
    let current = uuid;
    for (let i = 0; i < limit; i++) {
        const entity = entities.get(current);
        const next = entity?.components.get(SourceComponent)
            ?? entity?.components.get(OwnerComponent)?.owner;
        if (next === undefined || next === current) {
            return current;
        }
        current = next;
    }
    return current;
}

/**
 * Counts the docked player's still-flying bay fighters, keyed by the
 * ammo outfit each one came out of.
 *
 * A fighter carries only the id of the bay weapon that launched it
 * (BayFighterComponent), so it is attributed to the LOWEST-sorted owned
 * outfit whose `ammoFor` is that bay weapon. That is exactly the outfit
 * weapon_plugin's consumeAmmo spent and bay_plugin's refundFighterToBay
 * credits back, so the outfitter's arithmetic lines up with the
 * simulation's even when two outfits supply one bay.
 *
 * A fighter whose bay weapon matches no owned outfit id goes uncounted
 * — the same blind spot as the refund path, and for the same reason:
 * nothing here can enumerate every outfit in the game data to invent an
 * id. In practice consumeAmmo leaves spent entries at zero rather than
 * deleting them, so the id is present.
 *
 * `carrierUuid` is the docked ship's uuid. It is still meaningful even
 * though the ship itself has been pulled out of the display world
 * (browser.ts removes it before opening the spaceport): the fighters
 * left behind still point at it.
 */
export function countDeployedFighters(
    entities: ReadonlyMap<string, Entity>,
    carrierUuid: string,
    getOutfit: (id: string) => OutfitData | undefined): DeployedOutfitCounts {
    return ownedOutfitIds => {
        // bay weapon id -> the owned outfit that supplies it.
        const ammoOutfitFor = new Map<string, string>();
        for (const id of [...ownedOutfitIds].sort()) {
            const ammoFor = getOutfit(id)?.ammoFor;
            if (ammoFor && !ammoOutfitFor.has(ammoFor)) {
                ammoOutfitFor.set(ammoFor, id);
            }
        }

        const counts = new Map<string, number>();
        for (const [uuid, entity] of entities) {
            const fighter = entity.components.get(BayFighterComponent);
            if (!fighter) {
                continue;
            }
            if (ownerRoot(uuid, entities) !== carrierUuid) {
                continue;
            }
            const outfitId = ammoOutfitFor.get(fighter.bayWeaponId);
            if (outfitId === undefined) {
                continue;
            }
            counts.set(outfitId, (counts.get(outfitId) ?? 0) + 1);
        }
        return counts;
    };
}
