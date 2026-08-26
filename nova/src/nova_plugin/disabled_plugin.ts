import * as t from 'io-ts';
import { GetEntity } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementPhysicsComponent,
    MovementState,
    MovementStateComponent,
    MovementSystem,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import {
    MultiplayerData,
    replicationPolicies,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { System } from 'nova_ecs/system';
import {
    AppliedDamageEvent,
    DisabledComponent,
} from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { ArmorComponent } from './health_plugin';
import { cancelJumpFlight } from './jump_plugin';
import { Platform, PlatformResource } from './platform_plugin';
import { ShipComponent } from './ship_plugin';
import { WeaponsStateComponent } from './weapons_state';

/**
 * Crossing this fraction disables a surviving ship. Retail derives a
 * per-ship chance from fields and government rules that NovaJS does not yet
 * expose, so this deliberately uses one deterministic threshold for every
 * ship instead of inventing an approximation of those data.
 */
export const DISABLE_ARMOR_FRACTION = 0.25;

const DisabledLifecycleState = t.type({
    armorFraction: t.number,
});
export type DisabledLifecycleState =
    t.TypeOf<typeof DisabledLifecycleState>;
export const DisabledLifecycleComponent =
    new Component<DisabledLifecycleState>('DisabledLifecycleComponent');

replicationPolicies.register(DisabledLifecycleComponent, {
    codec: DisabledLifecycleState,
    authority: 'server',
});

function ownsSimulation(
    platform: Platform,
    multiplayer: { owner: string } | undefined,
): boolean {
    if (!multiplayer) {
        return true;
    }
    return !(platform === 'node' && multiplayer.owner !== 'server'
        || platform === 'browser' && multiplayer.owner === 'server');
}

function suppressMovementAndWeapons(
    entity: Parameters<typeof cancelJumpFlight>[0],
    movement: MovementState,
    physics: {
        acceleration: number,
        maxVelocity: number,
        movementType: MovementType,
        turnRate: number,
    },
    weapons: Map<string, {
        count: number,
        firing: boolean,
        target?: string,
    }> | undefined,
): void {
    movement.accelerating = 0;
    movement.turning = 0;
    movement.turnBack = false;
    movement.turnTo = null;
    movement.targetSpeed = movement.velocity.length;

    // Inertialess ships normally bend their velocity toward their heading
    // even at zero throttle. Disabled hulls must preserve their velocity, so
    // their remaining simulation is inertial with no steering authority.
    physics.acceleration = 0;
    physics.turnRate = 0;
    physics.movementType = MovementType.INERTIAL;
    cancelJumpFlight(entity, movement);

    for (const weapon of weapons?.values() ?? []) {
        weapon.firing = false;
        weapon.target = undefined;
    }
}

export const DisableOnDamageSystem = new System({
    name: 'DisableOnDamageSystem',
    events: [AppliedDamageEvent],
    args: [
        AppliedDamageEvent,
        GetEntity,
        ArmorComponent,
        ShipComponent,
        MovementStateComponent,
        MovementPhysicsComponent,
        Optional(WeaponsStateComponent),
        Optional(MultiplayerData),
        PlatformResource,
        Optional(DisabledComponent),
        Optional(DisabledLifecycleComponent),
        Optional(DestructionStartedComponent),
    ] as const,
    step(damage, entity, armor, _ship, movement, physics, weapons,
        multiplayer, platform, disabled, lifecycle, destructionStarted) {
        if (platform !== 'node' || disabled || lifecycle
            || destructionStarted || damage.armor <= 0 || armor.max <= 0
            || armor.current <= 0) {
            return;
        }

        const threshold = armor.max * DISABLE_ARMOR_FRACTION;
        const previousArmor = armor.current + damage.armor;
        if (previousArmor > threshold && armor.current <= threshold) {
            entity.components.set(DisabledComponent, true);
            entity.components.set(DisabledLifecycleComponent, {
                armorFraction: armor.current / armor.max,
            });
            if (ownsSimulation(platform, multiplayer)) {
                suppressMovementAndWeapons(
                    entity, movement, physics, weapons);
            }
        }
    },
});

export const DisabledSuppressionSystem = new System({
    name: 'DisabledSuppressionSystem',
    args: [
        DisabledComponent,
        GetEntity,
        MovementStateComponent,
        MovementPhysicsComponent,
        Optional(WeaponsStateComponent),
        Optional(MultiplayerData),
        PlatformResource,
        Optional(ArmorComponent),
        Optional(DestructionStartedComponent),
    ] as const,
    step(disabled, entity, movement, physics, weapons, multiplayer, platform,
        armor, destructionStarted) {
        if (!disabled || destructionStarted || armor && armor.current <= 0
            || !ownsSimulation(platform, multiplayer)) {
            return;
        }
        suppressMovementAndWeapons(entity, movement, physics, weapons);
    },
});

/**
 * Replicated player disablement can arrive between frames without a local
 * damage event. Suppressing once before integration prevents one last input
 * frame, while the ordinary late pass also clears AI intent written after
 * movement.
 */
export const DisabledPreMovementSystem = new System({
    name: 'DisabledPreMovementSystem',
    before: [MovementSystem],
    args: [
        DisabledComponent,
        GetEntity,
        MovementStateComponent,
        MovementPhysicsComponent,
        Optional(WeaponsStateComponent),
        Optional(MultiplayerData),
        PlatformResource,
        Optional(ArmorComponent),
        Optional(DestructionStartedComponent),
    ] as const,
    step(disabled, entity, movement, physics, weapons, multiplayer, platform,
        armor, destructionStarted) {
        if (!disabled || destructionStarted || armor && armor.current <= 0
            || !ownsSimulation(platform, multiplayer)) {
            return;
        }
        suppressMovementAndWeapons(entity, movement, physics, weapons);
    },
});

export const DisabledPlugin: Plugin = {
    name: 'DisabledPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(DisabledLifecycleComponent);
        deltaMaker.addComponent(DisabledLifecycleComponent, {
            componentType: DisabledLifecycleState,
        });
        world.addSystem(DisableOnDamageSystem);
        world.addSystem(DisabledPreMovementSystem);
        world.addSystem(DisabledSuppressionSystem);
    },
    remove(world) {
        world.removeSystem(DisableOnDamageSystem);
        world.removeSystem(DisabledPreMovementSystem);
        world.removeSystem(DisabledSuppressionSystem);
    },
};

export { DisabledComponent };
