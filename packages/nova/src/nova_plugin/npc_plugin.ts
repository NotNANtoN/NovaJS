import { ShipData } from "novadatainterface/ship_data";
import { Entities, GetWorld, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { CommunicatorResource, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { RandomResource } from "nova_ecs/plugins/random_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Optional } from "nova_ecs/optional";
import { Query } from "nova_ecs/query";
import { System } from "nova_ecs/system";
import { DeathEvent } from "./death_plugin.js";
import { makeShip } from "./make_ship.js";
import { ShipComponent } from "./ship_plugin.js";
import { TargetComponent } from "./target_component.js";
import { WeaponsStateComponent } from "./weapons_state.js";
import { SimulationGameDataResource } from "./game_data_resource.js";

const TargetsQuery = new Query([UUID, ShipComponent] as const);
function getValidTargets(targets: Array<readonly [string, any]>, selfUuid: string): string[] {
    return targets.filter(([targetId]) => targetId !== selfUuid)
        .map(([uuid]) => uuid);
}

export const ChooseRandomTargetComponent = new Component<{
    interval: number,
    nextTime?: number,
}>('ChooseRandomTargetComponent');

const ChooseRandomTargetAI = new System({
    name: 'ChooseRandomTarget',
    args: [TargetComponent, TargetsQuery, ChooseRandomTargetComponent,
        TimeResource, UUID, Entities, RandomResource] as const,
    step(target, targets, randomTargetData, time, uuid, entities, random) {
        if ((randomTargetData.nextTime ?? 0) > time.time &&
            target.target && entities.has(target.target)) {
            return;
        }
        randomTargetData.nextTime = time.time + randomTargetData.interval;

        const validTargets = getValidTargets(targets, uuid);

        if (validTargets.length === 0) {
            target.target = undefined;
            return;
        }

        target.target = validTargets[random.below(validTargets.length)];
    }
});

export const FollowComponent = new Component<undefined>('FollowComponent');
const FollowAI = new System({
    name: 'FollowAndShootAI',
    args: [MovementStateComponent, TargetComponent, FollowComponent] as const,
    step(movementState, target) {
        movementState.turnTo = target.target;
        movementState.accelerating = 1;
    }
});

export const ShootAllWeaponsComponent = new Component<undefined>('ShootAllWeaponsComponent');
const ShootAllWeaponsAI = new System({
    name: 'ShootAllWeaponsAI',
    args: [WeaponsStateComponent, SimulationGameDataResource, TargetComponent, ShootAllWeaponsComponent] as const,
    step(weapons, gameData, { target }) {
        for (const [id, weapon] of weapons) {
            const weaponType = gameData.data.Weapon.getCached(id)?.type;
            if (weaponType == null || weaponType === 'BayWeaponData') {
                // do not use bay weapons yet since there is no ammo limit.
                continue;
            };
            weapon.target = target;
            weapon.firing = true;
        }
    }
});


export const DeathAIComponent = new Component<undefined>('DeathAIComponent');
export const DeathAISystem = new System({
    name: 'DeathAISystem',
    events: [DeathEvent],
    args: [Entities, UUID, DeathAIComponent,
        Optional(MultiplayerData), GetWorld] as const,
    step(entities, uuid, _deathAI, multiplayerData, world) {
        // Entity existence has a single authority: the owner. Other peers
        // still run the death effects locally, but the entity is only
        // removed when the owner's remove message arrives. Removing it
        // locally would race the owner's deltas and resurrect the ship.
        // (Optional() does not support missing resources, so the
        // communicator is read through the world.)
        const communicator = world.resources.get(CommunicatorResource);
        if (multiplayerData && communicator?.uuid
            && multiplayerData.owner !== communicator.uuid) {
            return;
        }
        entities.delete(uuid);
    }
})

export function makeNpc(shipData: ShipData) {
    const ship = makeShip(shipData);
    ship.components.set(ChooseRandomTargetComponent, {
        interval: 10_000,
    });
    ship.components.set(FollowComponent, undefined);
    ship.components.set(ShootAllWeaponsComponent, undefined);
    ship.components.set(DeathAIComponent, undefined);
    return ship;
}

export const NpcPlugin: Plugin = {
    name: 'NpcPlugin',
    build(world) {
        world.addSystem(ChooseRandomTargetAI);
        world.addSystem(FollowAI);
        world.addSystem(ShootAllWeaponsAI);
        world.addSystem(DeathAISystem);
    },
    remove(world) {
        world.removeSystem(ChooseRandomTargetAI);
        world.removeSystem(FollowAI);
        world.removeSystem(ShootAllWeaponsAI);
    }
}

