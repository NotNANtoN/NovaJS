import { Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Optional } from "nova_ecs/optional";
import { PlatformResource } from "./platform_plugin";
import { CollisionSystem } from "./collisions_plugin";
import {
    CollisionHitter,
    CollisionHitterComponent,
} from "./collision_interaction";
import { DamagedEvent, PlayerDeathComponent } from "./death_plugin";
import { OwnerComponent, SourceComponent } from "./fire_weapon_plugin";
import {
    GovernmentRelation,
    GovernmentRelationResource,
    GovernmentRelationStore,
} from "./govt_relations";
import { ShipComponent } from "./ship_plugin";
import { Query } from "nova_ecs/query";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import { SingletonComponent } from "nova_ecs/world";
import { EntityMap } from "nova_ecs/entity_map";
import {
    ChooseRandomTargetComponent,
    GovtComponent,
    NpcAIComponent,
    NpcCombatRoleComponent,
} from "./npc_components";
import { TargetComponent } from "./target_component";
import type { Entity } from "nova_ecs/entity";
import { ArmorComponent, ShieldComponent } from "./health_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";

/**
 * A provocation is deliberately scoped to one ECS world (one system). It is
 * not a legal record and therefore disappears when the system world is
 * destroyed or the attacker leaves it.
 */
export const PROVOCATION_DAMAGE_FRACTION = 0.03;
export const PROVOCATION_DECAY_MS = 60_000;

interface DamageAccumulator {
    damage: number;
    lastDamageAt: number;
}

export interface ProvocationState {
    readonly attackersByVictimGovernment: Map<number, Set<string>>;
    readonly damageByVictimAttacker: Map<string, DamageAccumulator>;
    readonly lastProvocationAt: Map<string, number>;
    readonly personalAttackersByVictim: Map<string, Map<string, number>>;
}

export function createProvocationState(): ProvocationState {
    return {
        attackersByVictimGovernment: new Map(),
        damageByVictimAttacker: new Map(),
        lastProvocationAt: new Map(),
        personalAttackersByVictim: new Map(),
    };
}

function provocationKey(government: number, attacker: string): string {
    return `${government}:${attacker}`;
}

function damageKey(victim: string, attacker: string): string {
    return `${victim}:${attacker}`;
}

export function recordPersonalProvocation(
    state: ProvocationState,
    victim: string,
    attacker: string,
    now: number,
): void {
    let attackers = state.personalAttackersByVictim.get(victim);
    if (!attackers) {
        attackers = new Map();
        state.personalAttackersByVictim.set(victim, attackers);
    }
    attackers.set(attacker, now);
}

export function isPersonallyProvoked(
    state: ProvocationState,
    victim: string,
    attacker: string,
): boolean {
    return state.personalAttackersByVictim.get(victim)?.has(attacker) ?? false;
}

export function recordProvocation(
    state: ProvocationState,
    victimGovernment: number,
    attacker: string,
    now = 0,
): void {
    let attackers = state.attackersByVictimGovernment.get(victimGovernment);
    if (!attackers) {
        attackers = new Set();
        state.attackersByVictimGovernment.set(victimGovernment, attackers);
    }
    attackers.add(attacker);
    state.lastProvocationAt.set(provocationKey(victimGovernment, attacker), now);
}

/**
 * Accumulate damage against one victim. The threshold is relative to that
 * ship's total shield and armour, so a stray hit does not start a faction
 * war while sustained fire does.
 */
export function recordDamage(
    state: ProvocationState,
    victimGovernment: number,
    victim: string,
    attacker: string,
    damage: number,
    victimTotalHealth: number,
    now: number,
    propagateToGovernment = true,
): boolean {
    if (!Number.isFinite(damage) || damage <= 0
        || !Number.isFinite(victimTotalHealth) || victimTotalHealth <= 0) {
        return false;
    }

    const key = damageKey(victim, attacker);
    const previous = state.damageByVictimAttacker.get(key);
    const accumulator = previous && now - previous.lastDamageAt < PROVOCATION_DECAY_MS
        ? previous
        : { damage: 0, lastDamageAt: now };
    accumulator.damage += damage;
    accumulator.lastDamageAt = now;
    state.damageByVictimAttacker.set(key, accumulator);
    recordPersonalProvocation(state, victim, attacker, now);

    if (!propagateToGovernment
        || accumulator.damage < victimTotalHealth * PROVOCATION_DAMAGE_FRACTION) {
        return false;
    }

    recordProvocation(state, victimGovernment, attacker, now);
    return true;
}

export function clearProvocation(
    state: ProvocationState,
    entityUuid: string,
): void {
    state.personalAttackersByVictim.delete(entityUuid);
    for (const [victim, attackers] of state.personalAttackersByVictim) {
        attackers.delete(entityUuid);
        if (attackers.size === 0) {
            state.personalAttackersByVictim.delete(victim);
        }
    }
    for (const [government, attackers] of state.attackersByVictimGovernment) {
        attackers.delete(entityUuid);
        if (attackers.size === 0) {
            state.attackersByVictimGovernment.delete(government);
        }
        state.lastProvocationAt.delete(provocationKey(government, entityUuid));
    }
    for (const key of state.damageByVictimAttacker.keys()) {
        const separator = key.lastIndexOf(":");
        if (key.slice(0, separator) === entityUuid
            || key.slice(separator + 1) === entityUuid) {
            state.damageByVictimAttacker.delete(key);
        }
    }
}

export function pruneProvocations(
    state: ProvocationState,
    activeEntities: ReadonlySet<string>,
    now?: number,
): void {
    for (const [victim, attackers] of state.personalAttackersByVictim) {
        if (!activeEntities.has(victim)) {
            state.personalAttackersByVictim.delete(victim);
            continue;
        }
        for (const [attacker, lastDamageAt] of attackers) {
            if (!activeEntities.has(attacker)
                || now !== undefined
                && now - lastDamageAt >= PROVOCATION_DECAY_MS) {
                attackers.delete(attacker);
            }
        }
        if (attackers.size === 0) {
            state.personalAttackersByVictim.delete(victim);
        }
    }
    for (const [government, attackers] of state.attackersByVictimGovernment) {
        for (const attacker of attackers) {
            if (!activeEntities.has(attacker)) {
                attackers.delete(attacker);
                state.lastProvocationAt.delete(
                    provocationKey(government, attacker));
            }
        }
        if (attackers.size === 0) {
            state.attackersByVictimGovernment.delete(government);
        }
    }
    for (const [key, accumulator] of state.damageByVictimAttacker) {
        const separator = key.lastIndexOf(":");
        const victim = key.slice(0, separator);
        const attacker = key.slice(key.lastIndexOf(":") + 1);
        if (!activeEntities.has(victim)
            || !activeEntities.has(attacker)
            || now !== undefined
            && now - accumulator.lastDamageAt >= PROVOCATION_DECAY_MS) {
            state.damageByVictimAttacker.delete(key);
        }
    }
    if (now !== undefined) {
        for (const [key, provokedAt] of state.lastProvocationAt) {
            if (now - provokedAt < PROVOCATION_DECAY_MS) {
                continue;
            }
            const separator = key.indexOf(":");
            const government = Number(key.slice(0, separator));
            const attacker = key.slice(separator + 1);
            state.attackersByVictimGovernment.get(government)?.delete(attacker);
            if (state.attackersByVictimGovernment.get(government)?.size === 0) {
                state.attackersByVictimGovernment.delete(government);
            }
            state.lastProvocationAt.delete(key);
        }
    }
}

export function isProvoked(
    state: ProvocationState,
    actorGovernment: number,
    target: string,
    relationFor: (
        actorGovernment: number,
        victimGovernment: number,
    ) => GovernmentRelation | undefined,
): boolean {
    for (const [victimGovernment, attackers] of state.attackersByVictimGovernment) {
        if (!attackers.has(target)) {
            continue;
        }
        if (victimGovernment === actorGovernment
            || relationFor(actorGovernment, victimGovernment) === "ally") {
            return true;
        }
    }
    return false;
}

export const ProvocationResource =
    new Resource<ProvocationState>("NpcProvocation");

export { NpcAIComponent } from "./npc_components";

type DamageSourceEntry = readonly [
    CollisionHitter,
    string,
    string | undefined,
    { owner: string } | undefined,
    ShipComponentData | undefined,
];

type ShipComponentData = {
    id: string,
};

const DamageSourcesQuery = new Query([
    CollisionHitterComponent,
    UUID,
    Optional(SourceComponent),
    Optional(OwnerComponent),
    Optional(ShipComponent),
] as const, "NpcDamageSources");

const damageSourceByHitter =
    new WeakMap<CollisionHitter, string>();

function findShipUuid(
    start: string | undefined,
    entities: EntityMap,
    seen = new Set<string>(),
): string | undefined {
    if (!start || seen.has(start)) {
        return undefined;
    }
    seen.add(start);

    const entity = entities.get(start);
    if (!entity) {
        return undefined;
    }
    if (entity.components.has(ShipComponent)) {
        return start;
    }

    const source = entity.components.get(SourceComponent);
    const sourceShip = findShipUuid(source, entities, seen);
    if (sourceShip) {
        return sourceShip;
    }

    return findShipUuid(
        entity.components.get(OwnerComponent)?.owner,
        entities,
        seen,
    );
}

/**
 * Projectile and beam entities carry SourceComponent. Blasts reuse their
 * projectile's collision hitter but currently do not copy SourceComponent, so
 * this short-lived map preserves attribution across the explosion boundary.
 */
const TrackDamageSourcesSystem = new System({
    name: "TrackNpcDamageSources",
    before: [CollisionSystem],
    args: [DamageSourcesQuery, Entities] as const,
    step(sources, entities) {
        for (const [
            hitter, uuid, source, owner, ship,
        ] of sources as DamageSourceEntry[]) {
            const attacker = findShipUuid(source, entities)
                ?? findShipUuid(owner?.owner, entities, new Set([uuid]))
                ?? (ship ? uuid : undefined);
            if (attacker) {
                damageSourceByHitter.set(hitter, attacker);
            }
        }
    },
});

function resolveDamageSource(
    damager: string,
    entities: EntityMap,
): string | undefined {
    const damageEntity = entities.get(damager);
    const direct = findShipUuid(damager, entities);
    if (direct) {
        return direct;
    }
    const hitter = damageEntity?.components.get(CollisionHitterComponent);
    return hitter ? damageSourceByHitter.get(hitter) : undefined;
}

function isValidExternalAttacker(
    victim: Entity,
    attackerUuid: string | undefined,
    entities: EntityMap,
    relations: GovernmentRelationStore,
): attackerUuid is string {
    if (!attackerUuid || attackerUuid === victim.uuid) {
        return false;
    }
    const attacker = entities.get(attackerUuid);
    if (!attacker
        || !attacker.components.has(ShipComponent)
        || attacker.components.has(PlayerDeathComponent)) {
        return false;
    }

    const victimGovernment = victim.components.get(GovtComponent);
    const attackerGovernment = attacker.components.get(GovtComponent);
    if (!victimGovernment || !attackerGovernment) {
        // Player ships currently have no GovtComponent. They remain valid
        // external attackers and are checked by player combat rules later.
        return true;
    }
    if (victimGovernment.id === attackerGovernment.id) {
        return false;
    }
    return relations.relation(
        victimGovernment.id,
        attackerGovernment.id,
    ) !== "ally";
}

const ProvocationSystem = new System({
    name: "NpcProvocation",
    events: [DamagedEvent],
    args: [
        DamagedEvent,
        GetEntity,
        Entities,
        ProvocationResource,
        PlatformResource,
        Optional(ShieldComponent),
        Optional(ArmorComponent),
        TimeResource,
        GovernmentRelationResource,
        Optional(NpcCombatRoleComponent),
    ] as const,
    step({ damage, damager, scale = 1, fromExplosion }, victim, entities, provocations,
        platform, shield, armor, time, relations, combatRole) {
        if (platform !== "node" || fromExplosion) {
            return;
        }

        const victimGovernment = victim.components.get(GovtComponent);
        if (!victimGovernment) {
            return;
        }

        const attacker = resolveDamageSource(damager, entities);
        if (!isValidExternalAttacker(victim, attacker, entities, relations)) {
            return;
        }

        const totalHealth = (shield?.max ?? 0) + (armor?.max ?? 0);
        recordDamage(
            provocations,
            victimGovernment.id,
            victim.uuid,
            attacker,
            (damage.shield + damage.armor) * scale,
            totalHealth,
            time.time,
            combatRole === "military",
        );

        retaliate(victim, attacker, entities, time.time);
    },
});

/**
 * A ship that is shot fights back at once, as in EV Nova. The government-wide
 * provocation threshold above governs whether the rest of the faction joins
 * in; without this the victim itself would keep flying its old course until
 * its next scheduled target evaluation, up to ChooseRandomTarget's interval
 * away, which reads as the NPC ignoring being hit.
 */
function retaliate(
    victim: Entity,
    attacker: string,
    entities: EntityMap,
    now: number,
): void {
    if (!victim.components.has(NpcAIComponent)) {
        return;
    }
    const target = victim.components.get(TargetComponent);
    if (!target) {
        return;
    }
    if (target.target === attacker || !entities.has(attacker)) {
        return;
    }
    target.target = attacker;
    const chooseTarget = victim.components.get(ChooseRandomTargetComponent);
    if (chooseTarget) {
        // Hold the attacker for one interval instead of reverting to the
        // nearest valid target on the very next evaluation.
        chooseTarget.nextTime = now + chooseTarget.interval;
    }
}

const ProvocationCleanupSystem = new System({
    name: "NpcProvocationCleanup",
    args: [Entities, ProvocationResource, SingletonComponent, TimeResource] as const,
    step(entities, provocations, _singleton, time) {
        pruneProvocations(
            provocations,
            new Set([...entities].map(([uuid]) => uuid)),
            time.time,
        );
    },
});

// On the authoritative server, the client's local PlayerDeathEvent is not
// emitted. The replicated death marker lets hostility state be cleared in
// both local and server worlds before the player can respawn.
const PlayerDeathProvocationCleanupSystem = new System({
    name: "PlayerDeathProvocationCleanup",
    args: [PlayerDeathComponent, UUID, ProvocationResource] as const,
    step: (_death, uuid, provocations) => {
        clearProvocation(provocations, uuid);
    },
});

export const NpcHostilitySystems = {
    trackDamageSources: TrackDamageSourcesSystem,
    provocation: ProvocationSystem,
    cleanup: ProvocationCleanupSystem,
    playerDeathCleanup: PlayerDeathProvocationCleanupSystem,
};
