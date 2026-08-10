import { Emit, Entities, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { DeleteEvent, EcsEvent } from "nova_ecs/events";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { DeltaResource } from "nova_ecs/plugins/delta_plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { Provide } from "nova_ecs/provide";
import { Query } from "nova_ecs/query";
import { System } from "nova_ecs/system";
import { World } from "nova_ecs/world";
import { ExplodingComponent } from "./death_plugin.js";
import { findControlledEntity, ShipControlEvent, ShipControlStateComponent } from "./ship_control.js";
import { CloakActiveComponent, CloakScannerComponent, isTargetable } from "./cloak_plugin.js";
import { DisabledComponent } from "./disabled_component.js";
import { OwnerComponent } from "./fire_weapon_plugin.js";
import { isInFlock } from "./flock.js";
import { PlayerShipSelector } from "./player_ship_plugin.js";
import { ShipComponent } from "./ship_plugin.js";
import { Target, TargetComponent } from "./target_component.js";


export const TargetIndexComponent = new Component<{ index: number }>('TargetIndexComponent');

const TargetIndexProvider = Provide({
    name: "TargetIndexProvider",
    provided: TargetIndexComponent,
    args: [] as const,
    factory: () => ({ index: -1 }),
});

export const CycleTargetEvent = new EcsEvent<Target>('CycleTargetEvent');

const TargetsQuery = new Query([UUID, MovementStateComponent,
    Optional(OwnerComponent), ShipComponent, Optional(CloakActiveComponent),
    Optional(ExplodingComponent)] as const);
const ChooseTargetSystem = new System({
    name: 'ChooseTarget',
    events: [ShipControlEvent],
    args: [ShipControlStateComponent, TargetComponent, TargetIndexComponent, UUID,
        TargetsQuery, Emit, MovementStateComponent, Entities,
        Optional(CloakScannerComponent)] as const,
    step(controlState, target, index, uuid, ships, emit, movementState,
        entities, myScanner) {
        // The ship's own flock — escorts and anything transitively
        // following them (see flock.ts) — is excluded from general
        // targeting (tab / r) and cycled by escortTarget instead.
        // Click/tap targeting still reaches flock members
        // (applySetTarget below).
        const getEntity = (u: string) => entities.get(u);

        // Whether a candidate is hidden from the NORMAL (tab / r) cycle
        // because it is the ship's own flock member (owned fighter or
        // transitive escort). A DISABLED flock member is the exception:
        // dead in space, it rejoins the normal cycle so the player can
        // target it to board and repair it. It stays in the escortTarget
        // cycle regardless (that cycle keeps every flock member).
        const hiddenFromCycle = (u: string, ownerUuid: string | undefined) => {
            if (getEntity(u)?.components.has(DisabledComponent)) {
                return false;
            }
            return ownerUuid === uuid || isInFlock(u, uuid, getEntity);
        };

        if (controlState.get('escortTarget') === 'start') {
            // Cycle the flock in uuid order (deterministic regardless
            // of entity-map iteration order), starting after the
            // current target when it is already a flock member.
            const flock = ships
                .filter(([otherUuid, , , , cloak, exploding]) =>
                    isInFlock(otherUuid, uuid, getEntity)
                    && isTargetable(cloak, myScanner)
                    && exploding === undefined)
                .map(([otherUuid]) => otherUuid)
                .sort();
            if (flock.length === 0) {
                return;
            }
            // The cycle carries a "no target" step at the end, exactly
            // like the normal (tab) cycle below: index -1 means no
            // target, so the sequence is escort1 -> escort2 -> ... ->
            // no target -> escort1. A target that is NOT a flock member
            // (a normal target picked with tab/r) reads as -1 too, so
            // the first press enters the flock at its first member
            // rather than clearing the target.
            const currentIndex = target.target
                ? flock.indexOf(target.target) : -1;
            const nextIndex = (currentIndex + 2) % (flock.length + 1) - 1;
            target.target = nextIndex === -1 ? undefined : flock[nextIndex];
            emit(CycleTargetEvent, target);
            return;
        }

        if (controlState.get('nearestTarget') === 'start') {
            const [closestUuid, _distance, newIndex] = ships
                .map(([a, b, c, d, e, f], index) =>
                    [a, b, c, d, e, f, index] as const)
                .filter(([otherUuid, _, owner, __, cloak, exploding]) => {
                    if (hiddenFromCycle(otherUuid, owner?.owner)) {
                        return false;
                    }
                    // Cloaked ships are untargetable unless this ship has
                    // a cloak scanner that allows targeting them.
                    if (!isTargetable(cloak, myScanner)) {
                        return false;
                    }
                    // A ship in its death sequence is already gone.
                    if (exploding !== undefined) {
                        return false;
                    }
                    return otherUuid !== uuid;
                })
                .map(([uuid, { position }, _, __, ___, ____, index]) => [
                    uuid,
                    position.subtract(movementState.position).lengthSquared,
                    index
                ] as const)
                .reduce<readonly [string | undefined, number, number]>(
                    (a, b) => {
                        if (a[1] !== b[1]) {
                            return a[1] < b[1] ? a : b;
                        }
                        // Exactly equal distances: query iteration order
                        // can differ between a peer that built its entity
                        // map by insertion and one restored from a wire
                        // snapshot, so break the tie deterministically by
                        // the lexicographically smaller uuid.
                        return a[0] !== undefined && a[0] < b[0] ? a : b;
                    },
                    [undefined, Infinity, -1] as const);

            index.index = newIndex;
            target.target = closestUuid;
            emit(CycleTargetEvent, target);
            return;
        }

        if (controlState.get('nextTarget') !== 'start') {
            return;
        }

        // index ranges from [-1, ships.length) with -1 being no target.
        index.index = (index.index + 2) % (ships.length + 1) - 1;

        if (index.index !== -1) {
            // TODO; This is obtuse. Rewrite.
            while (true) {
                if (index.index === -1) {
                    break;
                }

                const [targetUuid, _targetMovement, targetOwner, _targetShip,
                    targetCloak, targetExploding] = ships[index.index];
                // Don't target yourself
                // Don't target your flock (escorts and their spawn),
                //   UNLESS a flock member is disabled (hiddenFromCycle)
                // Don't target cloaked ships (unless a cloak scanner allows it)
                // Don't target exploding ships (death sequence started)
                if (targetUuid !== uuid
                    && !hiddenFromCycle(targetUuid, targetOwner?.owner)
                    && isTargetable(targetCloak, myScanner)
                    && targetExploding === undefined) {
                    break;
                }
                index.index = (index.index + 2) % (ships.length + 1) - 1;
            }
        }

        if (index.index === -1) {
            target.target = undefined;
        } else {
            target.target = ships[index.index][0];
        }
        emit(CycleTargetEvent, target);
    }
});

/**
 * Applies a peer's explicit target choice (tap/click on a ship) to the
 * ship it controls: no targeting yourself, or ships your scanner can't
 * see through their cloak. Unlike tab/r cycling, an EXPLICIT click DOES
 * target the player's own flock (escorts, idle bay fighters) — that's
 * how you inspect your own ships. An invalid choice is dropped rather
 * than clamped so every peer resolves the input identically.
 */
export function applySetTarget(world: World, peerId: string | undefined,
    targetUuid: string | null) {
    const found = findControlledEntity(world, peerId);
    if (!found) {
        return;
    }
    const target = found.entity.components.get(TargetComponent);
    if (!target) {
        return;
    }
    if (targetUuid === null) {
        target.target = undefined;
        return;
    }
    const targetEntity = world.entities.get(targetUuid);
    if (!targetEntity
        || targetUuid === found.uuid
        || !targetEntity.components.has(ShipComponent)
        // Exploding ships are untargetable everywhere.
        || targetEntity.components.has(ExplodingComponent)) {
        return;
    }
    const cloak = targetEntity.components.get(CloakActiveComponent);
    const myScanner = found.entity.components.get(CloakScannerComponent);
    if (!isTargetable(cloak, myScanner)) {
        return;
    }
    target.target = targetUuid;
}

export const TargetRemovedEvent = new EcsEvent<string>('TargetRemovedEvent');
const TargetRemovedSystem = new System({
    name: 'TargetRemovedSystem',
    events: [DeleteEvent],
    args: [UUID, new Query([TargetComponent, UUID] as const), Emit] as const,
    step(uuid, withTarget, emit) {
        const targetRemoved: string[] = [];
        for (const [target, targeterUuid] of withTarget) {
            if (target.target === uuid) {
                target.target = undefined;
                targetRemoved.push(targeterUuid);
            }
        }
        emit(TargetRemovedEvent, uuid, targetRemoved);
    }
});

// Drops any SHIP's target that has become cloaked. A ship you were
// targeting that cloaks vanishes from your sensors, so the lock is lost —
// matching the "cloaked ships are untargetable" rule for locks already
// held. A cloak scanner that allows targeting cloaked ships keeps the
// lock. Gated on ShipComponent: projectiles keep their TargetComponent,
// so a homing missile's lock is SUSPENDED while its target is cloaked
// (it stops homing in ProjectileGuidanceSystem) and resumes on decloak,
// per observed original-game behavior.
const CloakedTargetQuery = new Query([UUID, CloakActiveComponent] as const);
const DropCloakedTargetSystem = new System({
    name: 'DropCloakedTarget',
    args: [TargetComponent, ShipComponent, CloakedTargetQuery,
        Optional(CloakScannerComponent)] as const,
    step(target, _ship, cloakedShips, myScanner) {
        if (!target.target) {
            return;
        }
        for (const [uuid, cloak] of cloakedShips) {
            if (uuid === target.target && !isTargetable(cloak, myScanner)) {
                target.target = undefined;
                return;
            }
        }
    }
});

/**
 * Drops ANY entity's target the moment that target starts its death
 * sequence (ExplodingComponent, set at zero armor): an exploding ship
 * is beyond shooting at, so locks break immediately — for the player,
 * NPCs, escorts, and guided weapons alike. ExplodingComponent is
 * shared sim state (snapshot/wire covered), so every peer drops the
 * lock on the same tick.
 */
const ExplodingShipsQuery = new Query([UUID, ExplodingComponent] as const);
const DropExplodingTargetSystem = new System({
    name: 'DropExplodingTarget',
    args: [TargetComponent, ExplodingShipsQuery] as const,
    step(target, explodingShips) {
        if (!target.target) {
            return;
        }
        for (const [uuid] of explodingShips) {
            if (uuid === target.target) {
                target.target = undefined;
                return;
            }
        }
    }
});

export const TargetPlugin: Plugin = {
    name: "TargetPlugin",
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }

        deltaMaker.addComponent(TargetComponent, {
            componentType: Target,
        });

        world.addSystem(TargetIndexProvider);
        world.addSystem(ChooseTargetSystem);
        world.addSystem(TargetRemovedSystem);
        world.addSystem(DropCloakedTargetSystem);
        world.addSystem(DropExplodingTargetSystem);
    }
}
