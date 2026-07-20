import { Entity } from 'nova_ecs/entity';
import { FiringGroupComponent } from './firing_group.js';
import { OwnerComponent } from './fire_weapon_plugin.js';
import { FormationComponent } from './npc_ai_plugin.js';

/**
 * ============================================================================
 * The player's flock: every ship that ultimately follows the player
 * ============================================================================
 *
 * "Own escorts" is TRANSITIVE: a hired escort follows the player, that
 * escort's bay fighters follow the escort, and all of them belong to
 * the player's flock — untargetable by tab/r, cycled by the escort-
 * target control, drawn with friendly corners.
 *
 * A ship's parent link, in priority order:
 *  1. FormationComponent.leader — who it holds formation on (hired
 *     escorts, fleet escorts, idle bay fighters).
 *  2. OwnerComponent.owner — the bay owner chain for launched fighters
 *     that are currently fighting (no formation while engaged).
 *  3. FiringGroupComponent.group — the friendly-fire group id, which
 *     fire_weapon_plugin stamps from the firer's group or owner-chain
 *     root. This is the same root the firing-group immunity uses
 *     (victimFiringGroup's ownerRoot fallback), so "belongs to the
 *     player's flock" and "can't friendly-fire the player" cannot
 *     drift apart: the group id IS a precomputed chain root.
 *
 * The walk is over synced, serializer-registered components only, so
 * every peer (and the display world) computes the same answer.
 * MAX_FLOCK_DEPTH plus a visited set guards against pathological
 * leader cycles (a following b following a).
 */
const MAX_FLOCK_DEPTH = 8;

/**
 * Whether the ship `uuid` belongs to `rootUuid`'s flock: following its
 * leader/owner/group chain reaches `rootUuid`. A ship is not in its
 * own flock (you can always target yourself... by not targeting).
 */
export function isInFlock(uuid: string, rootUuid: string,
    getEntity: (uuid: string) => Entity | undefined): boolean {
    if (uuid === rootUuid) {
        return false;
    }
    const visited = new Set<string>();
    let current = uuid;
    for (let depth = 0; depth < MAX_FLOCK_DEPTH; depth++) {
        if (visited.has(current)) {
            return false; // Leader cycle: nobody's flock.
        }
        visited.add(current);
        const entity = getEntity(current);
        if (!entity) {
            return false;
        }
        const parent = entity.components.get(FormationComponent)?.leader
            ?? entity.components.get(OwnerComponent)?.owner
            ?? entity.components.get(FiringGroupComponent)?.group;
        if (parent === undefined || parent === current) {
            return false;
        }
        if (parent === rootUuid) {
            return true;
        }
        current = parent;
    }
    return false;
}
