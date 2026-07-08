import { Emit, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { DeleteEvent, EcsEvent } from "nova_ecs/events";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { DeltaResource } from "nova_ecs/plugins/delta_plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { Provide } from "nova_ecs/provide";
import { Query } from "nova_ecs/query";
import { System } from "nova_ecs/system";
import { ShipControlEvent, ShipControlStateComponent } from "./ship_control.js";
import { CloakActiveComponent, CloakScannerComponent, isTargetable } from "./cloak_plugin.js";
import { OwnerComponent } from "./fire_weapon_plugin.js";
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

const TargetsQuery = new Query([UUID, MovementStateComponent, Optional(OwnerComponent), ShipComponent, Optional(CloakActiveComponent)] as const);
const ChooseTargetSystem = new System({
    name: 'ChooseTarget',
    events: [ShipControlEvent],
    args: [ShipControlStateComponent, TargetComponent, TargetIndexComponent, UUID,
        TargetsQuery, Emit, MovementStateComponent,
        Optional(CloakScannerComponent)] as const,
    step(controlState, target, index, uuid, ships, emit, movementState, myScanner) {
        if (controlState.get('nearestTarget') === 'start') {
            const [closestUuid, _distance, newIndex] = ships
                .map(([a, b, c, d, e], index) => [a, b, c, d, e, index] as const)
                .filter(([otherUuid, _, owner, __, cloak]) => {
                    if (owner?.owner === uuid) {
                        return false;
                    }
                    // Cloaked ships are untargetable unless this ship has
                    // a cloak scanner that allows targeting them.
                    if (!isTargetable(cloak, myScanner)) {
                        return false;
                    }
                    return otherUuid !== uuid;
                })
                .map(([uuid, { position }, _, __, ___, index]) => [
                    uuid,
                    position.subtract(movementState.position).lengthSquared,
                    index
                ] as const)
                .reduce<readonly [string | undefined, number, number]>(
                    (a, b) => a[1] < b[1] ? a : b,
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

                const [targetUuid, _targetMovement, targetOwner, _targetShip, targetCloak] = ships[index.index];
                // Don't target yourself
                // Don't target escorts
                // Don't target cloaked ships (unless a cloak scanner allows it)
                if (targetUuid !== uuid && targetOwner?.owner !== uuid
                    && isTargetable(targetCloak, myScanner)) {
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

// Drops any target that has become cloaked. A ship you were targeting
// that cloaks vanishes from your sensors, so the lock is lost — matching
// the "cloaked ships are untargetable" rule for locks already held. A
// cloak scanner that allows targeting cloaked ships keeps the lock.
const CloakedTargetQuery = new Query([UUID, CloakActiveComponent] as const);
const DropCloakedTargetSystem = new System({
    name: 'DropCloakedTarget',
    args: [TargetComponent, CloakedTargetQuery,
        Optional(CloakScannerComponent)] as const,
    step(target, cloakedShips, myScanner) {
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
    }
}
