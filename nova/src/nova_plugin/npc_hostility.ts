import { Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Optional } from "nova_ecs/optional";
import { PlatformResource } from "./platform_plugin";
import { CollisionSystem } from "./collisions_plugin";
import {
    CollisionHitter,
    CollisionHitterComponent,
} from "./collision_interaction";
import { AppliedDamageEvent, PlayerDeathComponent } from "./death_plugin";
import {
    AttackIntentComponent,
    OwnerComponent,
    SourceComponent,
} from "./fire_weapon_plugin";
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

export type ThreatReportReason = "deliberate-targeting" | "sustained-fire";

/**
 * An internal ship-to-ship security broadcast. This is combat simulation
 * state, not player-facing comm dialogue: once accepted by a government, its
 * lifetime is independent of the reporting victim entity.
 */
export interface ThreatReport {
    attacker: string;
    reportingGovernment: number;
    reportedBy?: string;
    reportedAt: number;
    expiresAt: number;
    reason: ThreatReportReason;
}

export interface ProvocationState {
    readonly attackersByVictimGovernment: Map<number, Set<string>>;
    readonly threatReportsByGovernment:
        Map<number, Map<string, ThreatReport>>;
    readonly damageByVictimAttacker: Map<string, DamageAccumulator>;
    readonly lastProvocationAt: Map<string, number>;
    readonly personalAttackersByVictim: Map<string, Map<string, number>>;
    readonly governmentProvocationsByVictim: Map<string, Set<string>>;
}

export function createProvocationState(): ProvocationState {
    return {
        attackersByVictimGovernment: new Map(),
        threatReportsByGovernment: new Map(),
        damageByVictimAttacker: new Map(),
        lastProvocationAt: new Map(),
        personalAttackersByVictim: new Map(),
        governmentProvocationsByVictim: new Map(),
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
    victim?: string,
    reason: ThreatReportReason = "sustained-fire",
): void {
    let attackers = state.attackersByVictimGovernment.get(victimGovernment);
    if (!attackers) {
        attackers = new Set();
        state.attackersByVictimGovernment.set(victimGovernment, attackers);
    }
    attackers.add(attacker);
    let reports = state.threatReportsByGovernment.get(victimGovernment);
    if (!reports) {
        reports = new Map();
        state.threatReportsByGovernment.set(victimGovernment, reports);
    }
    reports.set(attacker, {
        attacker,
        reportingGovernment: victimGovernment,
        reportedBy: victim,
        reportedAt: now,
        expiresAt: now + PROVOCATION_DECAY_MS,
        reason,
    });
    const key = provocationKey(victimGovernment, attacker);
    state.lastProvocationAt.set(key, now);
    if (victim) {
        let provocations = state.governmentProvocationsByVictim.get(victim);
        if (!provocations) {
            provocations = new Set();
            state.governmentProvocationsByVictim.set(victim, provocations);
        }
        provocations.add(key);
    }
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
    if (accumulator.damage < victimTotalHealth * PROVOCATION_DAMAGE_FRACTION) {
        return false;
    }

    recordPersonalProvocation(state, victim, attacker, now);
    if (propagateToGovernment) {
        recordProvocation(
            state, victimGovernment, attacker, now, victim, "sustained-fire");
    }
    return true;
}

export function recordDeliberateProvocation(
    state: ProvocationState,
    victimGovernment: number,
    victim: string,
    attacker: string,
    now: number,
    propagateToGovernment = true,
): void {
    recordPersonalProvocation(state, victim, attacker, now);
    if (propagateToGovernment) {
        recordProvocation(state, victimGovernment, attacker, now, victim,
            "deliberate-targeting");
    }
}

function clearGovernmentThreat(
    state: ProvocationState,
    government: number,
    attacker: string,
): void {
    state.attackersByVictimGovernment.get(government)?.delete(attacker);
    if (state.attackersByVictimGovernment.get(government)?.size === 0) {
        state.attackersByVictimGovernment.delete(government);
    }
    state.threatReportsByGovernment.get(government)?.delete(attacker);
    if (state.threatReportsByGovernment.get(government)?.size === 0) {
        state.threatReportsByGovernment.delete(government);
    }
    state.lastProvocationAt.delete(provocationKey(government, attacker));
}

export function clearProvocation(
    state: ProvocationState,
    entityUuid: string,
): void {
    // A victim disappearing only removes personal retaliation and report
    // provenance. Accepted security broadcasts belong to the government and
    // remain valid until attacker cleanup or expiry.
    state.governmentProvocationsByVictim.delete(entityUuid);
    state.personalAttackersByVictim.delete(entityUuid);
    for (const [victim, attackers] of state.personalAttackersByVictim) {
        attackers.delete(entityUuid);
        if (attackers.size === 0) {
            state.personalAttackersByVictim.delete(victim);
        }
    }
    for (const [government, attackers] of state.attackersByVictimGovernment) {
        if (attackers.has(entityUuid)) {
            clearGovernmentThreat(state, government, entityUuid);
        }
    }
    for (const [victim, keys] of state.governmentProvocationsByVictim) {
        for (const key of [...keys]) {
            if (key.slice(key.indexOf(":") + 1) === entityUuid) {
                keys.delete(key);
            }
        }
        if (keys.size === 0) {
            state.governmentProvocationsByVictim.delete(victim);
        }
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
                clearGovernmentThreat(state, government, attacker);
            }
        }
    }
    for (const victim of state.governmentProvocationsByVictim.keys()) {
        if (!activeEntities.has(victim)) {
            state.governmentProvocationsByVictim.delete(victim);
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
        for (const [government, reports] of
            [...state.threatReportsByGovernment]) {
            for (const [attacker, report] of [...reports]) {
                if (now < report.expiresAt) {
                    continue;
                }
                const key = provocationKey(government, attacker);
                clearGovernmentThreat(state, government, attacker);
                for (const [victim, keys] of
                    state.governmentProvocationsByVictim) {
                    keys.delete(key);
                    if (keys.size === 0) {
                        state.governmentProvocationsByVictim.delete(victim);
                    }
                }
            }
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
    for (const [victimGovernment, reports] of
        state.threatReportsByGovernment) {
        if (!reports.has(target)) {
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
    { target: string } | undefined,
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
    Optional(AttackIntentComponent),
] as const, "NpcDamageSources");

interface DamageAttribution {
    attacker: string;
    intendedTarget?: string;
}

const damageSourceByHitter =
    new WeakMap<CollisionHitter, DamageAttribution>();

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
            hitter, uuid, source, owner, ship, intent,
        ] of sources as DamageSourceEntry[]) {
            const attacker = findShipUuid(source, entities)
                ?? findShipUuid(owner?.owner, entities, new Set([uuid]))
                ?? (ship ? uuid : undefined);
            if (attacker) {
                damageSourceByHitter.set(hitter, {
                    attacker,
                    intendedTarget: intent?.target,
                });
            }
        }
    },
});

function resolveDamageSource(
    damager: string,
    entities: EntityMap,
): DamageAttribution | undefined {
    const damageEntity = entities.get(damager);
    const direct = findShipUuid(damager, entities);
    if (direct) {
        return {
            attacker: direct,
            intendedTarget: damageEntity?.components
                .get(AttackIntentComponent)?.target,
        };
    }
    const hitter = damageEntity?.components.get(CollisionHitterComponent);
    const tracked = hitter ? damageSourceByHitter.get(hitter) : undefined;
    const attacker = findShipUuid(
        damageEntity?.components.get(SourceComponent),
        entities,
    ) ?? findShipUuid(
        damageEntity?.components.get(OwnerComponent)?.owner,
        entities,
    ) ?? tracked?.attacker;
    return attacker ? {
        attacker,
        intendedTarget: damageEntity?.components
            .get(AttackIntentComponent)?.target ?? tracked?.intendedTarget,
    } : undefined;
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
    const relation = relations.relation(
        victimGovernment.id,
        attackerGovernment.id,
    );
    return relation === "enemy" || relation === "neutral";
}

const ProvocationSystem = new System({
    name: "NpcProvocation",
    events: [AppliedDamageEvent],
    args: [
        AppliedDamageEvent,
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
    step({ shield: shieldDamage, armor: armorDamage, damager, fromExplosion },
        victim, entities, provocations,
        platform, shield, armor, time, relations, combatRole) {
        if (platform !== "node") {
            return;
        }

        const victimGovernment = victim.components.get(GovtComponent);
        if (!victimGovernment) {
            return;
        }
        if (shieldDamage + armorDamage <= 0) {
            return;
        }

        const attribution = resolveDamageSource(damager, entities);
        const attacker = attribution?.attacker;
        if (!isValidExternalAttacker(
            victim,
            attacker,
            entities,
            relations,
        )) {
            return;
        }

        const totalHealth = (shield?.max ?? 0) + (armor?.max ?? 0);
        const propagateToGovernment =
            combatRole === "civilian" || combatRole === "military";
        const deliberate = !fromExplosion
            && attribution?.intendedTarget === victim.uuid;
        if (deliberate) {
            recordDeliberateProvocation(
                provocations,
                victimGovernment.id,
                victim.uuid,
                attacker,
                time.time,
                propagateToGovernment,
            );
            retaliate(victim, attacker, entities, time.time);
            return;
        }

        const thresholdCrossed = recordDamage(
            provocations,
            victimGovernment.id,
            victim.uuid,
            attacker,
            shieldDamage + armorDamage,
            totalHealth,
            time.time,
            propagateToGovernment,
        );
        if (thresholdCrossed) {
            retaliate(victim, attacker, entities, time.time);
        }
    },
});

/**
 * Deliberately targeted fire causes immediate retaliation. Untargeted damage
 * reaches this path only after the bounded cumulative threshold is crossed.
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
