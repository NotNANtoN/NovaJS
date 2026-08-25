import * as t from 'io-ts';
import { WeaponDamage } from 'novadatainterface/WeaponData';
import { Emit, RunQuery, UUID } from 'nova_ecs/arg_types';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementPhysicsComponent, MovementState, MovementStateComponent, MovementType } from 'nova_ecs/plugins/movement_plugin';
import { Time, TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { BlastDamageComponent } from './blast_plugin';
import { ArmorComponent, IonizationColorComponent, IonizationComponent, ShieldComponent } from './health_plugin';
import { ProjectileComponent } from './projectile_data';
import { ShipComponent, ShipDataComponent, ShipPhysicsComponent } from './ship_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { Position } from 'nova_ecs/datatypes/position';
import { Component } from 'nova_ecs/component';
import { GetEntity } from 'nova_ecs/arg_types';
import {
    PlayerStateComponent,
} from './player_state';
import { InitiateJumpEvent } from './jump_plugin';

// const DamageQuery = new Query([Optional(ShieldComponent), Optional(ArmorComponent),
// Optional(IonizationComponent), Optional(IonizationColorComponent),
// Optional(ProjectileComponent), TimeResource] as const);

export const DeathEvent = new EcsEvent<Time>('DeathEvent');
export const ZeroArmorEvent = new EcsEvent<Time>('ZeroArmorEvent');
export const DisabledComponent = new Component<boolean>('DisabledComponent');
export const DisableOnZeroArmorComponent =
    new Component<undefined>('DisableOnZeroArmorComponent');
const PlayerDeathState = t.type({
    respawnAt: t.number,
    wreckPosition: t.tuple([t.number, t.number]),
});
export const PlayerDeathComponent = new Component<t.TypeOf<typeof PlayerDeathState>>(
    'PlayerDeathComponent');

export const DamagedEvent = new EcsEvent<{
    damage: WeaponDamage,
    damager: string,
    scale?: number,
    fromExplosion?: boolean,
}>('DamagedEvent');

const DamageSystem = new System({
    name: 'DamageSystem',
    events: [DamagedEvent],
    args: [Emit, DamagedEvent, Optional(ShieldComponent), Optional(ArmorComponent),
        Optional(IonizationComponent), Optional(IonizationColorComponent),
        Optional(ProjectileComponent), Optional(PlayerDeathComponent),
        TimeResource, UUID] as const,
    step(emit, { damage, scale = 1 }, shield, armor, ionization, ionizationColor,
        isProjectile, playerDeath, time, uuid) {
        if (playerDeath) {
            return;
        }

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
            armor.current = Math.max(0, armor.current - damage.armor * scale)
            if (armor.current === 0) {
                emit(ZeroArmorEvent, time, [uuid]);
            }
        }
    }
});

const ExplodingComponent = new Component<number>('ShipExplodingComponent');
const ShipZeroArmorSystem = new System({
    name: 'ShipZeroArmorSystem',
    args: [ShipDataComponent, ZeroArmorEvent, GetEntity,
        Optional(DisableOnZeroArmorComponent)] as const,
    events: [ZeroArmorEvent],
    step(ship, zeroArmorTime, {components}, disableInstead) {
        if (disableInstead) {
            components.set(DisabledComponent, true);
            return;
        }
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
    }
});

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

        let direction: Vector;
        if (isBlast) {
            direction = movementState.position.subtract(otherMovement.position).normalize();
        } else {
            direction = otherMovement.rotation.getUnitVector();
        }
        movementState.velocity = movementState.velocity.add(
            direction.scale(damage.knockback * scale / targetMass * 5));
    }
});

// TODO: Put statuses of ship all in the same variable and make it
// easy to reset?
export const PlayerDeathSystem = new System({
    name: 'PlayerDeathSystem',
    args: [Optional(ShieldComponent), Optional(ArmorComponent),
           Optional(IonizationComponent), MovementStateComponent,
           PlayerShipSelector, DeathEvent, GetEntity] as const,
    events: [DeathEvent],
    step(shield, armor, ionization, movement, _playerShip, { time }, entity) {
        if (entity.components.has(PlayerDeathComponent)) {
            return;
        }
        if (shield) {
            shield.current = shield.max;
        }
        if (armor) {
            armor.current = armor.max;
        }
        if (ionization) {
            ionization.current = 0;
        }
        movement.velocity = new Vector(0, 0);
        const deathState: t.TypeOf<typeof PlayerDeathState> = {
            respawnAt: time + 2500,
            wreckPosition: [movement.position.x, movement.position.y],
        };
        entity.components.set(PlayerDeathComponent, deathState);
    }
});

const PlayerRespawnSystem = new System({
    name: 'PlayerRespawnSystem',
    args: [
        TimeResource,
        PlayerDeathComponent,
        Optional(ShieldComponent),
        Optional(ArmorComponent),
        Optional(IonizationComponent),
        Optional(PlayerStateComponent),
        MovementStateComponent,
        GetEntity,
        UUID,
        Emit,
        PlayerShipSelector,
    ] as const,
    step(time, death, shield, armor, ionization, playerState, movement,
        entity, uuid, emit) {
        if (time.time < death.respawnAt) {
            movement.position = new Position(...death.wreckPosition);
            movement.velocity = new Vector(0, 0);
            return;
        }
        const position: [number, number] =
            playerState?.lastLandedPosition ?? [0, 0];
        movement.position = new Position(...position);
        movement.velocity = new Vector(0, 0);
        if (shield) {
            shield.current = shield.max;
        }
        if (armor) {
            armor.current = armor.max;
        }
        if (ionization) {
            ionization.current = 0;
        }
        if (playerState?.lastLandedSystem
            && playerState.lastLandedSystem !== playerState.currentSystem) {
            emit(InitiateJumpEvent, { to: playerState.lastLandedSystem }, [uuid]);
        }
        entity.components.delete(PlayerDeathComponent);
    },
});

export const DeathPlugin: Plugin = {
    name: 'DeathPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(DisabledComponent);
        deltaMaker.addComponent(DisabledComponent, {
            componentType: t.boolean,
        });
        world.addComponent(PlayerDeathComponent);
        deltaMaker.addComponent(PlayerDeathComponent, {
            componentType: PlayerDeathState,
        });
        world.addSystem(DamageSystem);
        world.addSystem(KnockbackSystem);
        world.addSystem(PlayerDeathSystem);
        world.addSystem(ShipZeroArmorSystem);
        world.addSystem(ExplodingFinishedSystem);
        world.addSystem(PlayerRespawnSystem);
    },
    remove(world) {
        world.removeSystem(DamageSystem);
        world.removeSystem(KnockbackSystem);
        world.removeSystem(PlayerDeathSystem);
        world.removeSystem(ShipZeroArmorSystem);
        world.removeSystem(ExplodingFinishedSystem);
        world.removeSystem(PlayerRespawnSystem);
    }
}
