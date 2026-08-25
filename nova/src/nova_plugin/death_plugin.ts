import * as t from 'io-ts';
import { WeaponDamage } from 'novadatainterface/WeaponData';
import { ExplosionData } from 'novadatainterface/ExplosionData';
import {
    Emit,
    EmitNow,
    Entities,
    GetWorld,
    RunQuery,
    UUID,
} from 'nova_ecs/arg_types';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';
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
import { cancelJumpFlight } from './jump_plugin';
import { GameDataResource } from './game_data_resource';
import { framesToMilliseconds } from 'novaparse/src/parsers/Constants';
import { DestructionStartedComponent } from './destruction_state';
import { deImmerify } from '../util/deimmerify';

// const DamageQuery = new Query([Optional(ShieldComponent), Optional(ArmorComponent),
// Optional(IonizationComponent), Optional(IonizationColorComponent),
// Optional(ProjectileComponent), TimeResource] as const);

export const DeathEvent = new EcsEvent<Time>('DeathEvent');
export const ZeroArmorEvent = new EcsEvent<Time>('ZeroArmorEvent');
export interface RespawnRelocation {
    cause: 'respawn';
    entity: Entity;
    uuid: string;
    from: string;
    to: string;
}
export const RespawnRelocationEvent =
    new EcsEvent<RespawnRelocation>('RespawnRelocationEvent');
export const DisabledComponent = new Component<boolean>('DisabledComponent');
export const DisableOnZeroArmorComponent =
    new Component<undefined>('DisableOnZeroArmorComponent');
const PlayerDeathStateCodec = t.intersection([
    t.type({
        wreckPosition: t.tuple([t.number, t.number]),
        visualFallbackAt: t.number,
    }),
    t.partial({
        messageAt: t.number,
        respawnAt: t.number,
    }),
]);
export type PlayerDeathState = t.TypeOf<typeof PlayerDeathStateCodec>;
export const PlayerDeathComponent = new Component<PlayerDeathState>(
    'PlayerDeathComponent');
replicationPolicies.register(DisabledComponent, {
    codec: t.boolean,
    authority: 'server',
});
replicationPolicies.register(DestructionStartedComponent, {
    codec: t.boolean,
    authority: 'server',
});
replicationPolicies.register(PlayerDeathComponent, {
    codec: PlayerDeathStateCodec,
    authority: 'server',
});
// Leave 2.5 seconds of visible message time even when multiplayer/event
// delivery makes the overlay appear a frame or two after completion.
export const PLAYER_DEATH_MESSAGE_HOLD_MS = 2_700;
export const PLAYER_DEATH_VISUAL_FALLBACK_GRACE_MS = 2_000;

export const DamagedEvent = new EcsEvent<{
    damage: WeaponDamage,
    damager: string,
    scale?: number,
    fromExplosion?: boolean,
}>('DamagedEvent');

export const AppliedDamageEvent = new EcsEvent<{
    shield: number,
    armor: number,
    damager: string,
    fromExplosion?: boolean,
}>('AppliedDamageEvent');

export const PlayerDestructionCompleteEvent =
    new EcsEvent<Time>('PlayerDestructionCompleteEvent');

export function explosionVisualDurationMs(
    explosion: ExplosionData | undefined,
): number {
    if (!explosion) {
        return 0;
    }
    const frameCount = Math.max(
        0,
        ...Object.values(explosion.animation.images)
            .map(image => image.frames.normal.length),
    );
    const safeRate = Number.isFinite(explosion.rate) && explosion.rate > 0
        ? explosion.rate : 1;
    return framesToMilliseconds(frameCount / safeRate);
}

export function completePlayerDestruction(
    death: PlayerDeathState,
    completedAt: number,
): void {
    if (death.messageAt !== undefined) {
        return;
    }
    death.messageAt = completedAt;
    death.respawnAt = completedAt + PLAYER_DEATH_MESSAGE_HOLD_MS;
}

const DamageSystem = new System({
    name: 'DamageSystem',
    events: [DamagedEvent],
    args: [Emit, EmitNow, DamagedEvent,
        Optional(ShieldComponent), Optional(ArmorComponent),
        Optional(IonizationComponent), Optional(IonizationColorComponent),
        Optional(ProjectileComponent), Optional(PlayerDeathComponent),
        TimeResource, UUID] as const,
    step(emit, emitNow, { damage, scale = 1, damager, fromExplosion },
        shield, armor, ionization, ionizationColor, isProjectile, playerDeath,
        time, uuid) {
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

        let appliedShield = 0;
        let appliedArmor = 0;
        if (shield && !damage.passThroughShield) {
            const previousShield = Math.max(0, shield.current);
            shield.current -= damage.shield * scale;
            appliedShield = previousShield - Math.max(0, shield.current);
            if (shield.current > 0) {
                emitNow(AppliedDamageEvent, {
                    shield: appliedShield,
                    armor: 0,
                    damager,
                    fromExplosion,
                }, [uuid]);
                return;
            }
        }
        if (armor) {
            const previousArmor = armor.current;
            armor.current = Math.max(0, armor.current - damage.armor * scale)
            appliedArmor = previousArmor - armor.current;
            if (armor.current === 0) {
                emit(ZeroArmorEvent, time, [uuid]);
            }
        }
        emitNow(AppliedDamageEvent, {
            shield: appliedShield,
            armor: appliedArmor,
            damager,
            fromExplosion,
        }, [uuid]);
    }
});

const ExplodingComponent = new Component<number>('ShipExplodingComponent');
const ShipZeroArmorSystem = new System({
    name: 'ShipZeroArmorSystem',
    args: [ShipDataComponent, ZeroArmorEvent, GetEntity,
        Optional(DisableOnZeroArmorComponent)] as const,
    events: [ZeroArmorEvent],
    step(ship, zeroArmorTime, {components}, disableInstead) {
        components.set(DestructionStartedComponent, true);
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
            const offset =
                movementState.position.subtract(otherMovement.position);
            // A blast commonly originates exactly at its victim's position.
            // Normalizing that zero vector throws and aborts the entire world
            // step, freezing every ship in the system.
            if (offset.lengthSquared === 0) {
                return;
            }
            direction = offset.normalize();
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
           PlayerShipSelector, DeathEvent, GetEntity,
           Optional(ShipDataComponent), GetWorld] as const,
    events: [DeathEvent],
    step(_shield, _armor, _ionization, movement, _playerShip, { time }, entity,
        ship, world) {
        if (entity.components.has(PlayerDeathComponent)) {
            return;
        }
        movement.velocity = new Vector(0, 0);
        movement.accelerating = 0;
        movement.turning = 0;
        movement.turnTo = null;
        cancelJumpFlight(entity, movement);

        const explosion = ship?.finalExplosion
            ? world.resources.get(GameDataResource)
                ?.data.Explosion.getCached(ship.finalExplosion)
            : undefined;
        const visualDuration = explosionVisualDurationMs(explosion);
        const deathState: PlayerDeathState = {
            wreckPosition: [movement.position.x, movement.position.y],
            visualFallbackAt: time + visualDuration
                + PLAYER_DEATH_VISUAL_FALLBACK_GRACE_MS,
        };
        // Node worlds do not install the Pixi explosion completion system.
        // Use the same resource-derived visual lifetime for authoritative
        // respawn state; browsers finish on the actual rendered completion.
        if (typeof window === 'undefined') {
            completePlayerDestruction(deathState, time + visualDuration);
        }
        entity.components.set(PlayerDeathComponent, deathState);
    }
});

const PlayerDestructionCompleteSystem = new System({
    name: 'PlayerDestructionCompleteSystem',
    events: [PlayerDestructionCompleteEvent],
    args: [PlayerDestructionCompleteEvent, PlayerDeathComponent] as const,
    step({ time }, death) {
        completePlayerDestruction(death, time);
    },
});

const PlayerDestructionFallbackSystem = new System({
    name: 'PlayerDestructionFallbackSystem',
    args: [TimeResource, PlayerDeathComponent] as const,
    step(time, death) {
        if (death.messageAt === undefined
            && time.time >= death.visualFallbackAt) {
            completePlayerDestruction(death, time.time);
        }
    },
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
        Entities,
        UUID,
        Emit,
        PlayerShipSelector,
    ] as const,
    step(time, death, shield, armor, ionization, playerState, movement,
        entity, entities, uuid, emit) {
        if (death.respawnAt === undefined || time.time < death.respawnAt) {
            movement.position = new Position(...death.wreckPosition);
            movement.velocity = new Vector(0, 0);
            return;
        }
        const position: [number, number] =
            playerState?.lastLandedPosition ?? [0, 0];
        cancelJumpFlight(entity, movement);
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
        const from = playerState?.currentSystem;
        const to = playerState?.lastLandedSystem;
        if (playerState && to) {
            playerState.currentSystem = to;
        }
        entity.components.delete(DestructionStartedComponent);
        entity.components.delete(PlayerDeathComponent);
        if (from && to && from !== to) {
            entities.delete(uuid);
            deImmerify(entity);
            emit(RespawnRelocationEvent, {
                cause: 'respawn' as const,
                entity,
                uuid,
                from,
                to,
            });
        }
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
        world.addComponent(DestructionStartedComponent);
        deltaMaker.addComponent(DisabledComponent, {
            componentType: t.boolean,
        });
        deltaMaker.addComponent(DestructionStartedComponent, {
            componentType: t.boolean,
        });
        world.addComponent(PlayerDeathComponent);
        deltaMaker.addComponent(PlayerDeathComponent, {
            componentType: PlayerDeathStateCodec,
        });
        world.addSystem(DamageSystem);
        world.addSystem(KnockbackSystem);
        world.addSystem(PlayerDeathSystem);
        world.addSystem(PlayerDestructionCompleteSystem);
        world.addSystem(PlayerDestructionFallbackSystem);
        world.addSystem(ShipZeroArmorSystem);
        world.addSystem(ExplodingFinishedSystem);
        world.addSystem(PlayerRespawnSystem);
    },
    remove(world) {
        world.removeSystem(DamageSystem);
        world.removeSystem(KnockbackSystem);
        world.removeSystem(PlayerDeathSystem);
        world.removeSystem(PlayerDestructionCompleteSystem);
        world.removeSystem(PlayerDestructionFallbackSystem);
        world.removeSystem(ShipZeroArmorSystem);
        world.removeSystem(ExplodingFinishedSystem);
        world.removeSystem(PlayerRespawnSystem);
    }
}
