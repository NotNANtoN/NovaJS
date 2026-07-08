import * as t from 'io-ts';
import { CloakData, getDefaultCloakData } from 'novadatainterface/cloak_data';
import { GetEntity } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { registerEntityDeriver } from './entity_factory.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { DamagedEvent } from './death_plugin.js';
import { ShieldComponent } from './health_plugin.js';
import { OutfitsState, OutfitsStateComponent } from './outfit_plugin.js';
import { ProvideFromCache } from './provide_from_cache.js';
import { ShipControlEvent, ShipControlStateComponent } from './ship_control.js';

/**
 * A ship's cloaking capability, derived from its owned cloaking-device
 * outfits (oütf ModType 17). This is derived state, re-computed whenever
 * OutfitsStateComponent changes, exactly like WeaponsStateComponent — so
 * it is NOT snapshotted (the restore path re-derives it). See
 * novadatainterface/cloak_data.ts for the ModVal bitfield semantics.
 *
 * When a ship owns several cloaking devices we merge them conservatively:
 * boolean qualities OR together, and drain rates take the MINIMUM nonzero
 * rate (the cheapest device to run). `canCloak` is true iff at least one
 * cloak outfit is present.
 */
export interface CloakCapability extends CloakData {
    canCloak: boolean;
}

export const CloakComponent = new Component<CloakCapability>('CloakComponent');

/**
 * The live cloak toggle. This IS deterministic simulation state: it is
 * flipped by the 'cloak' control input (so every peer agrees) and must
 * survive rollback snapshots. Registered with the serializer/delta layer
 * and given an explicit snapshot policy in snapshot_policies.ts.
 */
export interface CloakActiveState {
    active: boolean;
}
export const CloakActiveType = t.type({ active: t.boolean });
export const CloakActiveComponent =
    new Component<CloakActiveState>('CloakActiveComponent');

/**
 * Whether a ship is currently cloaked (its CloakActiveComponent, if any,
 * is active). Undefined means the ship has no cloak state and so is not
 * cloaked.
 */
export function isCloaked(active: CloakActiveState | undefined): boolean {
    return active?.active === true;
}

/**
 * Whether a ship can be seen / targeted by others. Per the EVN Bible a
 * cloaked ship is untargetable unless the observer has a cloak scanner
 * (oütf ModType 30, not yet wired); for now an active cloak makes a ship
 * fully untargetable.
 */
export function isTargetable(active: CloakActiveState | undefined): boolean {
    return !isCloaked(active);
}

/**
 * Merges every owned cloaking device into a single capability. Returns a
 * non-cloak capability (canCloak: false) when the ship owns no cloak
 * outfits. Returns undefined only when outfit game data is not yet
 * cached (retry next step), matching the ProvideFromCache contract.
 */
export function deriveCloak(outfits: OutfitsState,
    gameData: SimulationGameDataInterface): CloakCapability | undefined {
    let merged: CloakCapability = {
        ...getDefaultCloakData(),
        canCloak: false,
    };

    for (const [id, state] of outfits) {
        if (state.count <= 0) {
            continue;
        }
        const outfit = gameData.data.Outfit.getCached(id);
        if (!outfit) {
            // Not loaded yet; retry next step.
            return undefined;
        }
        const cloak = outfit.cloak;
        if (!cloak.isCloak) {
            continue;
        }

        merged = {
            isCloak: true,
            canCloak: true,
            // Boolean qualities OR across devices.
            fasterFading: merged.fasterFading || cloak.fasterFading,
            hidesFromRadar: merged.hidesFromRadar || cloak.hidesFromRadar,
            dropsShieldsOnActivate:
                merged.dropsShieldsOnActivate || cloak.dropsShieldsOnActivate,
            deactivatesWhenHit:
                merged.deactivatesWhenHit || cloak.deactivatesWhenHit,
            areaCloak: merged.areaCloak || cloak.areaCloak,
            // Cheapest device wins: minimum nonzero drain.
            fuelPerSecond: minNonzero(merged.fuelPerSecond, cloak.fuelPerSecond),
            shieldPerSecond:
                minNonzero(merged.shieldPerSecond, cloak.shieldPerSecond),
            rawModVal: merged.rawModVal | cloak.rawModVal,
        };
    }

    return merged;
}

function minNonzero(a: number, b: number): number {
    if (a === 0) return b;
    if (b === 0) return a;
    return Math.min(a, b);
}

const CloakProvider = ProvideFromCache({
    name: 'CloakProvider',
    provided: CloakComponent,
    update: [OutfitsStateComponent],
    args: [OutfitsStateComponent, SimulationGameDataResource] as const,
    factory: deriveCloak,
});

/**
 * Fuel-drain hook. This branch has no fuel stat yet (a parallel agent is
 * building the fuel system). Cloaks that drain fuel would decloak on fuel
 * exhaustion; until a FuelComponent exists we treat fuel as unlimited and
 * only surface the intent here.
 *
 * TODO(fuel): when a fuel Stat/Component lands, subtract
 * `cloak.fuelPerSecond * delta_s` from it and return true (must decloak)
 * when fuel would go negative. Wire the same way CloakDrainSystem drains
 * shields below.
 */
export function drainCloakFuel(_cloak: CloakCapability, _delta_s: number): {
    /** True if fuel is exhausted and the ship must decloak. */
    mustDecloak: boolean;
} {
    return { mustDecloak: false };
}

/** A minimal shield-like value the pure transition helpers operate on. */
export interface ShieldLike {
    current: number;
    min: number;
}

/**
 * Pure toggle transition. Given the current active flag and capability,
 * returns the next active flag and whether shields should be dropped to
 * their floor on this transition. Returns `next === current` (no-op) when
 * the ship cannot cloak. Extracted from CloakControlSystem so the state
 * machine is unit-testable without a world.
 */
export function applyCloakToggle(current: boolean, cloak: CloakCapability): {
    next: boolean;
    dropShields: boolean;
} {
    if (!cloak.canCloak) {
        return { next: current, dropShields: false };
    }
    const next = !current;
    return {
        next,
        dropShields: next && cloak.dropsShieldsOnActivate,
    };
}

/**
 * Pure per-tick drain transition. Mutates the given shield (if present)
 * and returns the next active flag. Draining shields to their floor, or a
 * fuel-exhaustion signal from drainCloakFuel, forces a decloak. Extracted
 * from CloakDrainSystem for testing.
 */
export function applyCloakDrain(active: boolean, cloak: CloakCapability,
    delta_s: number, shield?: ShieldLike): boolean {
    if (!active) {
        return false;
    }

    if (cloak.shieldPerSecond > 0 && shield) {
        shield.current -= cloak.shieldPerSecond * delta_s;
        if (shield.current <= shield.min) {
            shield.current = shield.min;
            return false;
        }
    }

    if (cloak.fuelPerSecond > 0) {
        const { mustDecloak } = drainCloakFuel(cloak, delta_s);
        if (mustDecloak) {
            return false;
        }
    }

    return active;
}

/**
 * Pure decloak-on-hit transition: returns the next active flag when the
 * ship takes damage. Only cloaks with the deactivates-when-hit bit drop.
 */
export function applyDecloakOnHit(active: boolean, cloak: CloakCapability): boolean {
    if (active && cloak.deactivatesWhenHit) {
        return false;
    }
    return active;
}

/**
 * Toggles the cloak on the 'cloak' control edge. Runs on every peer's
 * ship from its own input record, so the toggle is deterministic. The
 * CloakActiveComponent is created lazily on first toggle: a ship that
 * never cloaks never carries one, and drain/decloak systems only run
 * once it exists.
 */
export const CloakControlSystem = new System({
    name: 'CloakControlSystem',
    events: [ShipControlEvent],
    args: [ShipControlStateComponent, CloakComponent,
        Optional(CloakActiveComponent), Optional(ShieldComponent),
        GetEntity] as const,
    step(controlState, cloak, active, shield, entity) {
        if (controlState.get('cloak') !== 'start') {
            return;
        }
        if (!cloak.canCloak) {
            return;
        }
        const current = active?.active ?? false;
        const { next, dropShields } = applyCloakToggle(current, cloak);
        if (active) {
            active.active = next;
        } else {
            entity.components.set(CloakActiveComponent, { active: next });
        }
        if (dropShields && shield) {
            // Activation immediately drops shields (bit 0x0004).
            shield.current = shield.min;
        }
    },
});

/**
 * Per-tick cloak drain and resource-exhaustion decloak. While cloaked,
 * shields drain by `shieldPerSecond`; if they hit the floor the cloak
 * drops. Fuel drain is delegated to drainCloakFuel (a no-op stub until a
 * fuel stat exists).
 */
export const CloakDrainSystem = new System({
    name: 'CloakDrainSystem',
    args: [CloakActiveComponent, CloakComponent, TimeResource,
        Optional(ShieldComponent)] as const,
    step(active, cloak, time, shield) {
        active.active = applyCloakDrain(active.active, cloak, time.delta_s, shield);
    },
});

/**
 * Decloaks a ship the moment it takes damage, for cloaking devices whose
 * ModVal sets bit 0x0008 ("Cloak deactivates when ship takes damage").
 */
export const CloakDecloakOnHitSystem = new System({
    name: 'CloakDecloakOnHitSystem',
    events: [DamagedEvent],
    args: [CloakActiveComponent, CloakComponent] as const,
    step(active, cloak) {
        active.active = applyDecloakOnHit(active.active, cloak);
    },
});

export const CloakPlugin: Plugin = {
    name: 'CloakPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }

        world.addComponent(CloakComponent);
        world.addComponent(CloakActiveComponent);

        // The active toggle is deterministic sim state: sync it as a
        // delta so a peer that missed the toggle input still converges,
        // and so late joiners see cloaked ships as cloaked.
        deltaMaker.addComponent(CloakActiveComponent, {
            componentType: CloakActiveType,
        });

        // Re-derive the capability wherever a full entity is built
        // (staged insertion, snapshot restore) so it is available on the
        // same tick, like weapons.
        registerEntityDeriver(world, {
            name: 'CloakDeriver',
            provided: CloakComponent,
            requires: [OutfitsStateComponent],
            derive: (entity, gameData) => deriveCloak(
                entity.components.get(OutfitsStateComponent)!, gameData),
        });

        world.addSystem(CloakProvider);
        world.addSystem(CloakControlSystem);
        world.addSystem(CloakDrainSystem);
        world.addSystem(CloakDecloakOnHitSystem);
    },
};
