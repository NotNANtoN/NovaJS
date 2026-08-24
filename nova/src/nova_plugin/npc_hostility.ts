import { Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Optional } from "nova_ecs/optional";
import { PlatformResource } from "./platform_plugin";
import { CollisionSystem } from "./collisions_plugin";
import {
    CollisionHitter,
    CollisionHitterComponent,
} from "./collision_interaction";
import { DamagedEvent } from "./death_plugin";
import { OwnerComponent, SourceComponent } from "./fire_weapon_plugin";
import {
    GovernmentRelation,
} from "./govt_relations";
import { ShipComponent } from "./ship_plugin";
import { Query } from "nova_ecs/query";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import { SingletonComponent } from "nova_ecs/world";
import { EntityMap } from "nova_ecs/entity_map";
import { GovtComponent } from "./npc_plugin";

/**
 * A provocation is deliberately scoped to one ECS world (one system). It is
 * not a legal record and therefore disappears when the system world is
 * destroyed or the attacker leaves it.
 */
export interface ProvocationState {
    readonly attackersByVictimGovernment: Map<number, Set<string>>;
}

export function createProvocationState(): ProvocationState {
    return {
        attackersByVictimGovernment: new Map(),
    };
}

export function recordProvocation(
    state: ProvocationState,
    victimGovernment: number,
    attacker: string,
): void {
    let attackers = state.attackersByVictimGovernment.get(victimGovernment);
    if (!attackers) {
        attackers = new Set();
        state.attackersByVictimGovernment.set(victimGovernment, attackers);
    }
    attackers.add(attacker);
}

export function clearProvocation(
    state: ProvocationState,
    attacker: string,
): void {
    for (const [government, attackers] of state.attackersByVictimGovernment) {
        attackers.delete(attacker);
        if (attackers.size === 0) {
            state.attackersByVictimGovernment.delete(government);
        }
    }
}

export function pruneProvocations(
    state: ProvocationState,
    activeEntities: ReadonlySet<string>,
): void {
    for (const [government, attackers] of state.attackersByVictimGovernment) {
        for (const attacker of attackers) {
            if (!activeEntities.has(attacker)) {
                attackers.delete(attacker);
            }
        }
        if (attackers.size === 0) {
            state.attackersByVictimGovernment.delete(government);
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

// This marker is intentionally not delta-serialized. It ensures that the AI
// systems run only for entities constructed by makeNpc on the authoritative
// server, never for replicated NPCs in a browser world.
export const NpcAIComponent =
    new Component<undefined>("NpcAIComponent");

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

const ProvocationSystem = new System({
    name: "NpcProvocation",
    events: [DamagedEvent],
    args: [
        DamagedEvent,
        GetEntity,
        Entities,
        ProvocationResource,
        PlatformResource,
    ] as const,
    step({ damager }, victim, entities, provocations, platform) {
        if (platform !== "node") {
            return;
        }

        const victimGovernment = victim.components.get(GovtComponent);
        if (!victimGovernment) {
            return;
        }

        const attacker = resolveDamageSource(damager, entities);
        if (!attacker || attacker === victim.uuid) {
            return;
        }

        recordProvocation(
            provocations,
            victimGovernment.id,
            attacker,
        );
    },
});

const ProvocationCleanupSystem = new System({
    name: "NpcProvocationCleanup",
    args: [Entities, ProvocationResource, SingletonComponent] as const,
    step(entities, provocations) {
        pruneProvocations(
            provocations,
            new Set([...entities].map(([uuid]) => uuid)),
        );
    },
});

export const NpcHostilitySystems = {
    trackDamageSources: TrackDamageSourcesSystem,
    provocation: ProvocationSystem,
    cleanup: ProvocationCleanupSystem,
};
