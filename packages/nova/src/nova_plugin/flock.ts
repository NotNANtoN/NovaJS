import { Entity } from 'nova_ecs/entity';
import { FiringGroupComponent, firingImmune, victimFiringGroup } from './firing_group.js';
import { OwnerComponent } from './fire_weapon_plugin.js';
import { FormationComponent, NpcComponent } from './npc_ai_plugin.js';

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
export const MAX_FLOCK_DEPTH = 8;

/**
 * One hop up the flock chain: who this ship follows, in the priority
 * order documented above (formation leader, then bay owner, then firing
 * group). The single definition of the chain edge, shared by isInFlock
 * and by the player-escort ownership walk (player_escort_plugin).
 */
export function flockParent(entity: Entity): string | undefined {
    return entity.components.get(FormationComponent)?.leader
        ?? entity.components.get(OwnerComponent)?.owner
        ?? entity.components.get(FiringGroupComponent)?.group;
}

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
        const parent = flockParent(entity);
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

/**
 * Guided-missile provocation: locking a GUIDED missile onto a ship is
 * itself an act of war — the moment the missile spawns with a target,
 * that target turns hostile to the shooter (a brave trader fights
 * back, a wimpy trader runs, a warship engages), no damage required.
 * Called from the projectile spawn path (deterministic sim event on
 * every peer), NOT from the hit handler.
 *
 * Exempt: the shooter's own transitive flock (escorts and fighters —
 * a stray lock on your own wing is not a betrayal) and anything in
 * the shooter's firing group (fleetmates; the same immunity that
 * makes their shots pass through each other).
 *
 * The effect reuses the NPC aggression channel (npc.aggressor) and
 * zeroes the think timer so the reaction is immediate rather than
 * waiting out the current decision interval.
 */
export function provokeGuidedLock(target: string, source: string | undefined,
    ownerRoot: string,
    getEntity: (uuid: string) => Entity | undefined): void {
    const victim = getEntity(target);
    const npc = victim?.components.get(NpcComponent);
    if (!victim || !npc) {
        return;
    }
    if (isInFlock(target, ownerRoot, getEntity)) {
        return;
    }
    const shooter = source ? getEntity(source) : undefined;
    const shooterGroup = shooter?.components.get(FiringGroupComponent)?.group
        ?? ownerRoot;
    const victimGroup = victimFiringGroup(
        victim.components.get(FiringGroupComponent),
        victim.components.get(OwnerComponent)?.owner, target);
    if (firingImmune(shooterGroup, victimGroup, undefined, undefined)) {
        return;
    }
    npc.aggressor = source ?? ownerRoot;
    npc.nextDecision = 0;
}
