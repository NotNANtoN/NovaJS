import { Emit, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { DeleteEvent, EcsEvent } from "nova_ecs/events";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { DeltaResource } from "nova_ecs/plugins/delta_plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { replicationPolicies } from "nova_ecs/plugins/multiplayer_plugin";
import { Provide } from "nova_ecs/provide";
import { Query } from "nova_ecs/query";
import { System } from "nova_ecs/system";
import { ControlStateEvent } from "./control_state_event";
import { OwnerComponent } from "./fire_weapon_plugin";
import { PlayerShipSelector } from "./player_ship_plugin";
import { ShipComponent } from "./ship_plugin";
import { Target, TargetComponent } from "./target_component";
import { CloakStateComponent } from "./cloaking_plugin";
import { AsteroidComponent } from "./asteroid_plugin";


const TargetIndexComponent = new Component<{ index: number }>('TargetIndexComponent');

const TargetIndexProvider = Provide({
    name: "TargetIndexProvider",
    provided: TargetIndexComponent,
    args: [TargetComponent] as const,
    factory: () => ({ index: -1 }),
});

export const CycleTargetEvent = new EcsEvent<Target>('CycleTargetEvent');

const TargetsQuery = new Query([UUID, MovementStateComponent, Optional(OwnerComponent), ShipComponent, Optional(CloakStateComponent)] as const);
const AsteroidTargetsQuery = new Query([UUID, MovementStateComponent, AsteroidComponent] as const);
export const ChooseTargetSystem = new System({
    name: 'ChooseTarget',
    events: [ControlStateEvent],
    args: [ControlStateEvent, TargetComponent, TargetIndexComponent, UUID,
        TargetsQuery, AsteroidTargetsQuery, Emit, MovementStateComponent, PlayerShipSelector] as const,
    step(controlState, target, index, uuid, ships, asteroids, emit, movementState) {
        const validShips = ships.filter(([otherUuid, _, owner, __ship, cloak]) => {
            if (cloak?.cloaked && cloak.alpha < 0.5) {
                return false;
            }
            if (owner?.owner === uuid) {
                return false;
            }
            return otherUuid !== uuid;
        });

        if (controlState.get('nearestTarget') === 'start') {
            let closestUuid: string | undefined;
            let closestDistSq = Infinity;
            let newIndex = -1;
            for (let i = 0; i < validShips.length; i++) {
                const [otherUuid, { position }] = validShips[i];
                const distSq = position.subtract(movementState.position).lengthSquared;
                if (distSq < closestDistSq) {
                    closestDistSq = distSq;
                    closestUuid = otherUuid;
                    newIndex = i;
                }
            }
            // Fall back to the nearest asteroid when no targetable ship is in system.
            if (!closestUuid) {
                for (let i = 0; i < asteroids.length; i++) {
                    const [asteroidUuid, { position }] = asteroids[i];
                    const distSq = position.subtract(movementState.position).lengthSquared;
                    if (distSq < closestDistSq) {
                        closestDistSq = distSq;
                        closestUuid = asteroidUuid;
                        newIndex = validShips.length + i;
                    }
                }
            }

            index.index = newIndex;
            target.target = closestUuid;
            emit(CycleTargetEvent, target);
            return;
        }

        if (controlState.get('nextTarget') !== 'start') {
            return;
        }

        const candidates: string[] = [
            ...validShips.map(([otherUuid]) => otherUuid),
            ...asteroids.map(([asteroidUuid]) => asteroidUuid),
        ];
        if (candidates.length === 0) {
            index.index = -1;
            target.target = undefined;
            emit(CycleTargetEvent, target);
            return;
        }

        const currentPos = target.target ? candidates.indexOf(target.target) : -1;
        const nextPos = currentPos + 1;
        if (nextPos >= candidates.length) {
            index.index = -1;
            target.target = undefined;
        } else {
            index.index = nextPos;
            target.target = candidates[nextPos];
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
        if (targetRemoved.length > 0) {
            emit(TargetRemovedEvent, uuid, targetRemoved);
        }
    }
});

replicationPolicies.register(TargetComponent, {
    codec: Target,
    authority: 'entity-owner',
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
        world.addComponent(TargetComponent);

        world.addSystem(TargetIndexProvider);
        world.addSystem(ChooseTargetSystem);
        world.addSystem(TargetRemovedSystem);
    }
}
