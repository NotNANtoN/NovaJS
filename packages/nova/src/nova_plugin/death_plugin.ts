import { WeaponDamage } from 'novadatainterface/weapon_data';
import { Components, Emit, RunQuery, UUID } from 'nova_ecs/arg_types';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementPhysicsComponent, MovementState, MovementStateComponent, MovementType, teleport } from 'nova_ecs/plugins/movement_plugin';
import { passthroughType, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { Time, TimeResource, TimeSystem } from 'nova_ecs/plugins/time_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { registerSimulationBridgeEvent } from '../communication/simulation_bridge_events.js';
import { BlastDamageComponent } from './blast_data.js';
import { ArmorComponent, IonizationColorComponent, IonizationComponent, ShieldComponent } from './health_plugin.js';
import { ProjectileComponent } from './projectile_data.js';
import { ShipComponent, ShipDataComponent, ShipPhysicsComponent } from './ship_plugin.js';
import { ControlledByComponent } from './ship_control.js';
import { Position } from 'nova_ecs/datatypes/position';
import { Component } from 'nova_ecs/component';
import { GetEntity } from 'nova_ecs/arg_types';

// const DamageQuery = new Query([Optional(ShieldComponent), Optional(ArmorComponent),
// Optional(IonizationComponent), Optional(IonizationColorComponent),
// Optional(ProjectileComponent), TimeResource] as const);

export const DeathEvent = new EcsEvent<Time>('DeathEvent');
export const ZeroArmorEvent = new EcsEvent<Time>('ZeroArmorEvent');

export const DamagedEvent = new EcsEvent<{ damage: WeaponDamage, damager: string, scale?: number }>('DamagedEvent');

registerSimulationBridgeEvent({ event: DeathEvent });
registerSimulationBridgeEvent({ event: ZeroArmorEvent });

const DamageSystem = new System({
    name: 'DamageSystem',
    events: [DamagedEvent],
    args: [Emit, DamagedEvent, Optional(ShieldComponent), Optional(ArmorComponent),
        Optional(IonizationComponent), Optional(IonizationColorComponent),
        Optional(ProjectileComponent), TimeResource, UUID] as const,
    step(emit, { damage, scale = 1 }, shield, armor, ionization, ionizationColor, isProjectile, time, uuid) {

        const hasShield = shield && shield.max > 0;
        if (isProjectile && !hasShield) {
            // This is a projectile, so use point defense damage scaling.
            damage = {
                ...damage,
                armor: damage.armor + damage.shield / 2,
            };
        }

        if (damage.ionization !== 0 && ionization) {
            ionization.current += damage.ionization * scale;
            if (ionizationColor) {
                ionizationColor.color = damage.ionizationColor;
            }
        }

        if (shield && !damage.passThroughShield) {
            shield.current -= damage.shield * scale;
            if (shield.current > 0) {
                return;
            }
        }
        if (armor) {
            // weap Flags2 0x1000 "can disable but not destroy": armor
            // damage from such a weapon clamps just above zero, so an
            // ion barrage can pound a ship far below its disable
            // threshold (leaving it thoroughly disabled) but can never
            // deliver the killing blow — that takes one tap from any
            // normal weapon.
            const floor = damage.disableOnly
                ? disableOnlyArmorFloor(armor.max) : 0;
            armor.current = Math.max(floor,
                armor.current - damage.armor * scale);
            if (armor.current === 0) {
                emit(ZeroArmorEvent, time, [uuid]);
            }
        }
    }
});

/**
 * The armor floor a disable-only weapon can reach: DISABLE_ONLY_ARMOR_FLOOR
 * (1 armor point) — far below any disable threshold, small enough that a
 * single hit from even the lightest lethal weapon finishes the ship.
 * Degenerate targets with max armor <= 1 floor at half their armor
 * instead so the clamp never exceeds the target's actual armor pool.
 */
export const DISABLE_ONLY_ARMOR_FLOOR = 1;
export function disableOnlyArmorFloor(maxArmor: number): number {
    return Math.min(DISABLE_ONLY_ARMOR_FLOOR, maxArmor / 2);
}

export const ExplodingComponent = new Component<number>('ShipExplodingComponent');
const ShipZeroArmorSystem = new System({
    name: 'ShipZeroArmorSystem',
    args: [ShipDataComponent, ZeroArmorEvent, GetEntity] as const,
    events: [ZeroArmorEvent],
    step(ship, zeroArmorTime, {components}) {
        if (components.has(ExplodingComponent)) {
            return;
        }
        // TODO: Normalize all times to ms
        const deathTime = ship.deathDelay * 1000 + zeroArmorTime.time;
        components.set(ExplodingComponent, deathTime);
    }
});

const ExplodingFinishedSystem = new System({
    name: 'ExplodingFinishedSystem',
    args: [TimeResource, ExplodingComponent, GetEntity, UUID, Emit] as const,
    step(time, endExplosionTime, entity, uuid, emit) {
        if (endExplosionTime < time.time) {
            entity.components.delete(ExplodingComponent);
            emit(DeathEvent, time, [uuid]);
        }
    },
    // Determinism rule 4: the explosion end check compares against
    // time.time, so this must run after TimeSystem advances the clock.
    after: [TimeSystem],
});

/**
 * The unit direction a knockback impulse shoves a target in, given the
 * damager that hit it.
 *
 * A blast pushes *radially outward from its center* — along the
 * difference between the target's position and the blast's — so an
 * explosion scatters what it catches away from itself. Every other
 * damager (projectile, beam) pushes along its own facing, which is the
 * direction it was travelling when it landed. A blast entity has a
 * rotation too, but it is meaningless (inherited from whatever spawned
 * the blast), so using it would fling targets off in an arbitrary
 * shared direction instead of outward.
 *
 * Returns null when a blast sits exactly on top of its target: the
 * position difference has no direction to normalize (Vector.normalize
 * throws on a zero-length vector), and "no impulse" is the only
 * well-defined answer. Callers skip the knockback.
 *
 * Deterministic: the degenerate test is an exact zero compare, and the
 * normalize is a correctly-rounded sqrt.
 */
export function knockbackDirection(targetPosition: Position,
    damagerMovement: MovementState, isBlast: boolean): Vector | null {
    if (!isBlast) {
        return damagerMovement.rotation.getUnitVector();
    }
    // Subtract as Positions — that wraps the delta to the shortest way
    // around the toroidal world — but drop to a plain Vector before
    // normalizing. Position's arithmetic re-wraps every result, so a
    // Position direction would silently wrap the caller's `.scale()`
    // once the impulse exceeded BOUNDARY, flipping a big shove around
    // to point back the way it came.
    const difference = Vector.fromVectorLike(
        targetPosition.subtract(damagerMovement.position));
    if (difference.lengthSquared === 0) {
        return null;
    }
    return difference.normalize();
}

const MovementQuery = new Query([MovementStateComponent, Optional(BlastDamageComponent)] as const);
const KnockbackSystem = new System({
    name: 'KnockbackSystem',
    events: [DamagedEvent],
    args: [DamagedEvent, MovementStateComponent, MovementPhysicsComponent,
        Optional(ShipPhysicsComponent), RunQuery] as const,
    step({ damage, damager, scale = 1 }, movementState, movementPhysics, shipPhysics, runQuery) {
        const val = runQuery(MovementQuery, damager);
        if (!val[0]) {
            return;
        }
        const [otherMovement, isBlast] = val[0];

        let targetMass = 1;
        if (shipPhysics) {
            targetMass = shipPhysics.mass || 1;
        }

        const direction = knockbackDirection(
            movementState.position, otherMovement, Boolean(isBlast));
        if (!direction) {
            return;
        }
        movementState.velocity = movementState.velocity.add(
            direction.scale(damage.knockback * scale / targetMass * 5));
    }
});

// TODO: Put statuses of ship all in the same variable and make it
// easy to reset?
export const PlayerDeathSystem = new System({
    name: 'PlayerDeathSystem',
    // Gated on ControlledBy (synced), NOT PlayerShipSelector
    // (peer-local): every world must respawn a dead player ship
    // identically, or the owner's world revives it at the origin
    // while everyone else's leaves a zero-armor wreck re-exploding
    // in place — a guaranteed desync on every player death.
    args: [Optional(ShieldComponent), Optional(ArmorComponent),
           Optional(IonizationComponent), MovementStateComponent,
           ControlledByComponent] as const,
    events: [DeathEvent],
    step(shield, armor, ionization, movement) {
        if (shield) {
            shield.current = shield.max;
        }
        if (armor) {
            armor.current = armor.max;
        }
        if (ionization) {
            ionization.current = 0;
        }
        // Teleport (rather than set position) so the respawn is sent to
        // other players, who otherwise only hear about input changes.
        teleport(movement, new Position(0, 0));
    }
});

export const DeathPlugin: Plugin = {
    name: 'DeathPlugin',
    build(world) {
        world.resources.get(SerializerResource)?.addEvent(DeathEvent, passthroughType<Time>('DeathEventType'));
        world.resources.get(SerializerResource)?.addEvent(ZeroArmorEvent, passthroughType<Time>('ZeroArmorEventType'));
        //const runQuery = world.resources.get(RunQuery)!;
        //const emit = world.resources.get(Emit)!;
        world.addSystem(DamageSystem);
        world.addSystem(KnockbackSystem);
        world.addSystem(PlayerDeathSystem);
        world.addSystem(ShipZeroArmorSystem);
        world.addSystem(ExplodingFinishedSystem);
    },
    remove(world) {
        world.removeSystem(DamageSystem);
        world.removeSystem(KnockbackSystem);
        world.removeSystem(PlayerDeathSystem);
        world.removeSystem(ShipZeroArmorSystem);
        world.removeSystem(ExplodingFinishedSystem);
    }
}
