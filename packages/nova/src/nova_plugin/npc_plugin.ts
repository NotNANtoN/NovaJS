import { ShipData } from "novadatainterface/ship_data";
import { Entities, GetWorld, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import * as t from 'io-ts';
import { CommunicatorResource, ExcludedMultiplayerComponentsResource, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { markerType, SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { RandomResource } from "nova_ecs/plugins/random_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Optional } from "nova_ecs/optional";
import { Query } from "nova_ecs/query";
import { System } from "nova_ecs/system";
import { CloakActiveComponent, CloakActiveState, isTargetable } from "./cloak_plugin.js";
import { DeathEvent } from "./death_plugin.js";
import { makeShip } from "./make_ship.js";
import { ShipComponent } from "./ship_plugin.js";
import { TargetComponent } from "./target_component.js";
import { WeaponsStateComponent } from "./weapons_state.js";
import { SimulationGameDataResource } from "./game_data_resource.js";

// Cloaked ships (CloakActiveComponent.active) are invisible to NPC AI, so
// they are excluded as valid targets — same rule the player's targeting
// uses. A cloak scanner would reveal them, but that outfit is not wired.
const TargetsQuery = new Query([UUID, ShipComponent, Optional(CloakActiveComponent)] as const);
export function getValidTargets(
    targets: Array<readonly [string, unknown, CloakActiveState | undefined]>,
    selfUuid: string): string[] {
    return targets
        .filter(([targetId, , cloak]) => targetId !== selfUuid && isTargetable(cloak))
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
    args: [Entities, UUID, DeathAIComponent] as const,
    step(entities, uuid) {
        // In input-driven multiplayer every peer simulates the same
        // deaths at the same ticks, so removal needs no authority or
        // message: it is deterministic.
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
        // NPC AI components must survive the serializer roundtrip that
        // entity-insertion inputs go through, but they are excluded
        // from multiplayer state: only the owner's sim runs the AI.
        const serializer = world.resources.get(SerializerResource);
        serializer?.addComponent(ChooseRandomTargetComponent, t.intersection([
            t.type({ interval: t.number }),
            t.partial({ nextTime: t.number }),
        ]));
        serializer?.addComponent(FollowComponent, markerType);
        serializer?.addComponent(ShootAllWeaponsComponent, markerType);
        serializer?.addComponent(DeathAIComponent, markerType);
        const excluded = world.resources.get(ExcludedMultiplayerComponentsResource)
            ?? new Set<string>();
        for (const component of [ChooseRandomTargetComponent, FollowComponent,
            ShootAllWeaponsComponent, DeathAIComponent]) {
            excluded.add(component.name);
        }
        world.resources.set(ExcludedMultiplayerComponentsResource, excluded);

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

