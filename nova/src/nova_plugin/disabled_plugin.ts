import { ShipData } from 'novadatainterface/ShipData';
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
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import {
    AppliedDamageEvent,
    DisabledComponent,
} from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { ArmorComponent } from './health_plugin';
import { cancelJumpFlight } from './jump_plugin';
import { Platform, PlatformResource } from './platform_plugin';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import { WeaponsStateComponent } from './weapons_state';

/**
 * Retail's thresholds, from the Bible's shïp Flags: a ship "is disabled at
 * 10% armour instead of 33%" when 0x0010 is set. Retail data sets it on 141
 * of the 288 hulls, and they are the warships, so a freighter gives up while
 * a Fed Destroyer fights on.
 */
export const DISABLE_ARMOR_FRACTION = 0.33;
export const TOUGH_DISABLE_ARMOR_FRACTION = 0.10;
const TOUGH_HULL_FLAG = 0x0010;

export function disableArmorFraction(
    ship: Pick<ShipData, 'flags'> | undefined,
): number {
    return (ship?.flags ?? 0) & TOUGH_HULL_FLAG
        ? TOUGH_DISABLE_ARMOR_FRACTION
        : DISABLE_ARMOR_FRACTION;
}

const DisabledLifecycleState = t.type({
    armorFraction: t.number,
    /**
     * Armour at the moment of disablement. Shields come back on a crippled
     * ship but the hull does not, so armour recharge is held to this ceiling
     * and only an outside repair can lift it.
     */
    armorCeiling: t.number,
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
        Optional(ShipDataComponent),
        MovementStateComponent,
        MovementPhysicsComponent,
        Optional(WeaponsStateComponent),
        Optional(MultiplayerData),
        PlatformResource,
        Optional(DisabledComponent),
        Optional(DisabledLifecycleComponent),
        Optional(DestructionStartedComponent),
    ] as const,
    step(damage, entity, armor, _ship, shipData, movement, physics, weapons,
        multiplayer, platform, disabled, lifecycle, destructionStarted) {
        if (platform !== 'node' || disabled || lifecycle
            || destructionStarted || damage.armor <= 0 || armor.max <= 0
            || armor.current <= 0) {
            return;
        }

        const threshold = armor.max * disableArmorFraction(shipData);
        const previousArmor = armor.current + damage.armor;
        if (previousArmor > threshold && armor.current <= threshold) {
            entity.components.set(DisabledComponent, true);
            entity.components.set(DisabledLifecycleComponent, {
                armorFraction: armor.current / armor.max,
                armorCeiling: armor.current,
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

/**
 * Hold the hull where the disabling blow left it, and hand control back only
 * once something has restored it completely.
 *
 * A crippled ship's shields come back but its hull does not, so armour
 * recharge is clamped to the ceiling recorded at disablement. That leaves a
 * full hull as an unambiguous signal that somebody repaired the ship — a
 * mechanic answering a distress call, or the fresh hull a respawn provides,
 * which is also what clears the flag that used to survive death and leave the
 * pilot unable to move.
 */
export const DisabledRecoverySystem = new System({
    name: 'DisabledRecoverySystem',
    args: [
        DisabledComponent,
        GetEntity,
        ArmorComponent,
        Optional(DisabledLifecycleComponent),
        Optional(MultiplayerData),
        PlatformResource,
        Optional(DestructionStartedComponent),
    ] as const,
    step(disabled, entity, armor, lifecycle, multiplayer, platform,
        destructionStarted) {
        if (!disabled || destructionStarted
            || !ownsSimulation(platform, multiplayer) || armor.max <= 0) {
            return;
        }
        if (armor.current >= armor.max) {
            entity.components.delete(DisabledComponent);
            entity.components.delete(DisabledLifecycleComponent);
            return;
        }
        if (lifecycle && armor.current > lifecycle.armorCeiling) {
            armor.current = lifecycle.armorCeiling;
        }
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
        world.addSystem(DisabledRecoverySystem);
    },
    remove(world) {
        world.removeSystem(DisableOnDamageSystem);
        world.removeSystem(DisabledPreMovementSystem);
        world.removeSystem(DisabledSuppressionSystem);
        world.removeSystem(DisabledRecoverySystem);
    },
};

export { DisabledComponent };
