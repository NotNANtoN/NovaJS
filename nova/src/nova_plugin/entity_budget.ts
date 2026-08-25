import { GetEntity } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { DeleteEvent } from 'nova_ecs/events';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';

export type CompatibilityProfile = 'classic' | 'modern';
export type BudgetKind =
    'ship' | 'projectile' | 'beam' | 'explosion' | 'asteroid';

/**
 * The original Nova per-system limits. These are budgets rather than array
 * sizes: entities that cannot be created are rejected at their spawn point.
 */
export const CLASSIC_ENTITY_LIMITS: Readonly<Record<BudgetKind, number>> = {
    ship: 64,
    projectile: 128,
    beam: 64,
    explosion: 32,
    asteroid: 16,
};

/**
 * Keep a small portion of the classic projectile pool available for the
 * player's input. NPC fire must not be able to make the player's weapon
 * appear jammed.
 */
export const PLAYER_PROJECTILE_RESERVE = 16;

/**
 * Modern mode keeps simulation entities unbounded. Explosions are presentation
 * entities, so a bounded cosmetic budget prevents a particle storm from
 * taking down the simulation without deleting a mission ship.
 */
export const MODERN_COSMETIC_LIMITS: Readonly<Partial<Record<BudgetKind, number>>> = {
    explosion: 64,
};

export class EntityBudget {
    private readonly counts = new Map<BudgetKind, number>();

    constructor(
        readonly profile: CompatibilityProfile = 'modern',
        private readonly classicLimits: Readonly<Record<BudgetKind, number>> =
            CLASSIC_ENTITY_LIMITS,
    ) { }

    limit(kind: BudgetKind): number {
        if (this.profile === 'classic') {
            return this.classicLimits[kind];
        }
        return MODERN_COSMETIC_LIMITS[kind] ?? Infinity;
    }

    active(kind: BudgetKind): number {
        return this.counts.get(kind) ?? 0;
    }

    /**
     * Reserve one slot. Critical entities may exceed a modern cosmetic budget,
     * while classic mode preserves the original hard limits.
     */
    tryAcquire(kind: BudgetKind, critical = false): boolean {
        const limit = this.limit(kind);
        const ordinaryLimit = kind === 'projectile'
            && this.profile === 'classic'
            ? Math.max(0, limit - PLAYER_PROJECTILE_RESERVE)
            : limit;
        const effectiveLimit = critical ? limit : ordinaryLimit;
        if (this.active(kind) >= effectiveLimit
            && (this.profile === 'classic' || !critical)) {
            return false;
        }
        this.counts.set(kind, this.active(kind) + 1);
        return true;
    }

    release(kind: BudgetKind): void {
        const remaining = this.active(kind) - 1;
        if (remaining <= 0) {
            this.counts.delete(kind);
        } else {
            this.counts.set(kind, remaining);
        }
    }
}

export const EntityBudgetResource =
    new Resource<EntityBudget>('EntityBudgetResource');
export const CompatibilityProfileResource =
    new Resource<CompatibilityProfile>('CompatibilityProfileResource');

/**
 * This component is local bookkeeping and deliberately is not registered with
 * DeltaPlugin or SerializerPlugin. It therefore never crosses the multiplayer
 * wire and does not affect replicated component compatibility.
 */
export const EntityBudgetTag = new Component<{ kind: BudgetKind }>(
    'EntityBudgetTag',
);

export function reserveEntity(
    budget: EntityBudget,
    entity: { components: { set(component: typeof EntityBudgetTag, value: { kind: BudgetKind }): unknown } },
    kind: BudgetKind,
    critical = false,
): boolean {
    if (!budget.tryAcquire(kind, critical)) {
        return false;
    }
    entity.components.set(EntityBudgetTag, { kind });
    return true;
}

const ReleaseBudgetOnDelete = new System({
    name: 'ReleaseEntityBudget',
    events: [DeleteEvent],
    args: [EntityBudgetTag, EntityBudgetResource, GetEntity] as const,
    step(tag, budget, entity) {
        budget.release(tag.kind);
        entity.components.delete(EntityBudgetTag);
    },
});

export function createEntityBudget(
    profile: CompatibilityProfile = 'modern',
): EntityBudget {
    return new EntityBudget(profile);
}

export const EntityBudgetPlugin: Plugin = {
    name: 'EntityBudgetPlugin',
    build(world) {
        if (!world.resources.has(EntityBudgetResource)) {
            world.resources.set(EntityBudgetResource, createEntityBudget());
        }
        world.addComponent(EntityBudgetTag);
        world.addSystem(ReleaseBudgetOnDelete);
    },
    remove(world) {
        world.removeSystem(ReleaseBudgetOnDelete);
        world.resources.delete(EntityBudgetResource);
    },
};
