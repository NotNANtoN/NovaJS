import * as t from 'io-ts';
import { ProjectileWeaponData, WeaponData } from 'novadatainterface/weapon_data';
import { Emit, EmitNow, Entities, GetEntity, RunQueryFunction, UUID } from 'nova_ecs/arg_types';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position, PositionType } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementPhysicsComponent, MovementStateComponent, MovementType } from 'nova_ecs/plugins/movement_plugin';
import { passthroughType, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import SAT from "sat";
import { registerSimulationBridgeEvent } from '../communication/simulation_bridge_events.js';
import { AnimationComponent } from './animation_plugin.js';
import { IdFactoryResource } from './id_factory.js';
import { ProvideFromCache } from './provide_from_cache.js';
import { BlastDamageComponent, BlastIgnoreComponent } from './blast_plugin.js';
import { CompositeHull, hullFromAnimation, HurtboxHullComponent } from './collisions_plugin.js';
import { CollisionEvent, CollisionHitterComponent, CollisionVulnerabilityComponent } from './collision_interaction.js';
import { CreateTime } from './create_time.js';
import { DamagedEvent, ZeroArmorEvent } from './death_plugin.js';
import { FireSubs, OwnerComponent, SourceComponent, SubCounts, VulnerableToPD, WeaponConstructors, WeaponEntry } from './fire_weapon_plugin.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { guidanceAngle, Guidance, GuidanceComponent, MissileGuidanceResource } from './guidance.js';
import { JamSteerComponent, MissileJammingSystem } from './jamming_plugin.js';
import { ArmorComponent, ShieldComponent } from './health_plugin.js';
import { ProjectileBlastHull, ProjectileComponent, ProjectileDataComponent } from './projectile_data.js';
import { SoundEvent } from './sound_plugin.js';
import { Stat } from './stat.js';
import { TargetComponent } from './target_component.js';


class ProjectileWeaponEntry extends WeaponEntry {
    declare data: ProjectileWeaponData;
    private buildProjectile: () => Entity;
    protected pointDefenseRangeSquared: number;

    constructor(data: WeaponData, runQuery: RunQueryFunction) {
        if (data.type !== 'ProjectileWeaponData') {
            throw new Error('Data must be ProjectileWeaponData');
        }
        super(data, runQuery);

        this.pointDefenseRangeSquared = (data.physics.speed * data.shotDuration / 1000) ** 2;

        let hitTypes = new Set(['normal']);
        if (data.guidance === 'pointDefense') {
            hitTypes = new Set(['pointDefense']);
        }

        // Projectiles are built fresh for every shot. Pooling entity
        // objects would leak state between timelines: the pool is not
        // part of a snapshot, so resimulation would dequeue different
        // objects than the original run did.
        this.buildProjectile = () => {
            const projectile = new Entity(this.data.name)
                .addComponent(ProjectileDataComponent, this.data)
                .addComponent(ProjectileComponent, { id: this.data.id })
                .addComponent(MovementStateComponent, {
                    position: new Position(0, 0),
                    rotation: new Angle(0),
                    velocity: new Vector(0, 0),
                    accelerating: this.data.guidance === 'rocket' ? 1 : 0,
                    turning: 0,
                    turnBack: false,
                }).addComponent(MovementPhysicsComponent, {
                    acceleration: this.data.physics.acceleration || 1200,
                    maxVelocity: this.data.guidance === 'rocket' ?
                        this.data.physics.speed : Infinity,
                    turnRate: this.data.physics.turnRate,
                    movementType: this.data.guidance === 'guided'
                        ? MovementType.INERTIALESS : MovementType.INERTIAL,
                }).addComponent(CollisionHitterComponent, {
                    hitTypes: new Set(hitTypes),
                });

            if (this.data.vulnerableTo.length) {
                projectile.addComponent(CollisionVulnerabilityComponent, {
                    vulnerableTo: new Set(this.data.vulnerableTo),
                });
            }
            if (this.data.guidance === 'guided') {
                projectile.addComponent(GuidanceComponent, {
                    guidance: Guidance.firstOrder,
                });
            }
            if (this.data.vulnerableTo.includes('pointDefense')) {
                projectile.addComponent(VulnerableToPD, undefined);
                projectile.addComponent(ShieldComponent, new Stat({
                    current: this.data.physics.shield,
                    max: this.data.physics.shield,
                    recharge: this.data.physics.shieldRecharge,
                }));
                projectile.addComponent(ArmorComponent, new Stat({
                    current: this.data.physics.armor,
                    max: this.data.physics.armor,
                    recharge: this.data.physics.armorRecharge,
                }));
            }

            if (this.data.proxRadius) {
                const proxHull = new CompositeHull([
                    new SAT.Circle(new SAT.Vector(0, 0), this.data.proxRadius)
                ]);
                projectile.components.set(HurtboxHullComponent, proxHull);
            }

            if (this.data.blastRadius) {
                const blastHull = new CompositeHull([
                    new SAT.Circle(new SAT.Vector(0, 0), this.data.blastRadius)
                ]);
                projectile.components.set(ProjectileBlastHull, blastHull);
            }

            return projectile;
        };
    }

    fire(position: Position, angle: Angle, owner?: string, target?: string,
        source?: string, sourceVelocity?: Vector): Entity | undefined {

        let velocity = new Vector(0, 0);
        if (this.data.guidance !== 'guided' && sourceVelocity) {
            velocity = velocity.add(sourceVelocity);
        }
        if (this.data.guidance !== 'rocket') {
            velocity = velocity.add(angle.getUnitVector()
                .scale(this.data.physics.speed));
        }

        const projectile = this.buildProjectile();

        const movementState = projectile.components.get(MovementStateComponent)!;
        movementState.position = position;
        movementState.rotation = angle;
        movementState.velocity = velocity;
        movementState.turning = 0;
        movementState.turnTo = null;

        projectile.components.delete(CreateTime);
        projectile.components.delete(SubCounts);

        if (target) {
            projectile.components.set(TargetComponent, { target });
        } else {
            projectile.components.delete(TargetComponent);
        }

        if (source) {
            projectile.components.set(SourceComponent, source);
        } else {
            projectile.components.delete(SourceComponent);
        }

        if (owner) {
            projectile.components.set(OwnerComponent, {owner: owner});
        } else {
            projectile.components.delete(OwnerComponent);
        }

        const armor = projectile.components.get(ArmorComponent);
        if (armor) {
            armor.current = armor.max;
        }

        const shield = projectile.components.get(ShieldComponent);
        if (shield) {
            shield.current = shield.max;
        }

        this.entities.set(this.ids.next('projectile'), projectile);
        if (this.data.sound) {
            this.emit(SoundEvent, {
                id: this.data.sound,
                loop: this.data.loopSound,
            });
        }

        return projectile;
    }
}

export const ProjectileExpireEvent = new EcsEvent<undefined>('ProjectileExpire');

const ProjectileLifespanSystem = new System({
    name: 'ProjectileLifespanSystem',
    args: [CreateTime, TimeResource, ProjectileDataComponent, FireSubs,
        Entities, UUID, Emit, ProjectileComponent] as const,
    step(fireTime, { time }, projectileData, fireSubs, entities, uuid, emit) {
        if (time - fireTime > projectileData.shotDuration) {
            fireSubs(projectileData.id, uuid, true);
            const self = entities.get(uuid);
            if (!self) {
                console.warn(`Missing projectile ${uuid} that is expiring`);
                return;
            }
            entities.delete(uuid);
            emit(ProjectileExpireEvent, undefined, [self]);
        }
    },
});

const ProjectileGuidanceSystem = new System({
    name: 'ProjectileGuidanceSystem',
    // Runs after MissileJammingSystem so a jammed missile's per-frame steer
    // override / retarget is already in place when we compute the aim.
    after: [MissileJammingSystem],
    args: [MovementStateComponent, TargetComponent,
        Entities, ProjectileDataComponent, MissileGuidanceResource,
        Optional(JamSteerComponent)] as const,
    step(movementState, { target }, entities, projectileData, guidanceMode,
        jamSteer) {
        // Jamming may have told this missile to fly straight this frame (lost
        // lock, no special seeker behaviour): ignore the target entirely.
        if (jamSteer === 'flyStraight') {
            movementState.turnTo = null;
            return;
        }
        if (!target) {
            return;
        }
        const targetEntity = entities.get(target);
        const targetMovement = targetEntity?.components.get(MovementStateComponent);

        if (!targetMovement) {
            return;
        }

        // 'smart' leads the target (hard to dodge); 'simple' just points at
        // the target's current position (dodgeable by circling). The mode is
        // a room-wide deterministic resource; see guidance.ts.
        let aim = guidanceAngle(guidanceMode.mode,
            movementState.position, movementState.velocity,
            targetMovement.position, targetMovement.velocity,
            projectileData.shotSpeed);

        // A jammed 'turns away if jammed' missile veers off: aim 180 degrees
        // away from where it would otherwise steer, so it peels away from the
        // target this frame.
        if (jamSteer === 'veerAway') {
            aim = aim.add(Math.PI);
        }

        movementState.turnTo = aim;
    }
});

export const ProjectileCollisionEventType = t.type({
    otherUuid: t.string,
    position: PositionType,
    projectileData: passthroughType<ProjectileWeaponData>('ProjectileCollisionProjectileData'),
});
export const ProjectileCollisionEvent = new EcsEvent<{
    otherUuid: string,
    position: Position,
    projectileData: ProjectileWeaponData,
}>('ProjectileCollision');

registerSimulationBridgeEvent({
    event: ProjectileCollisionEvent,
    includeEntityUuids: false,
});

const ProjectileHurtboxProvider = ProvideFromCache({
    name: "ProjectileHurtboxProvider",
    provided: HurtboxHullComponent,
    args: [AnimationComponent, SimulationGameDataResource, CollisionHitterComponent, ProjectileComponent] as const,
    factory: hullFromAnimation,
});

const ProjectileCollisionSystem = new System({
    name: 'ProjectileCollisionSystem',
    events: [CollisionEvent],
    args: [CollisionEvent, Entities, UUID, ProjectileDataComponent,
        Optional(OwnerComponent), FireSubs, TimeResource, CreateTime, EmitNow] as const,
    step(collision, entities, uuid, projectileData, owner, fireSubs, time, createTime, emitNow) {
        const other = entities.get(collision.other);
        if (!other) {
            return;
        }
        const otherOwner = other.components.get(OwnerComponent);
        if (collision.other === owner?.owner || otherOwner?.owner === owner?.owner) {
            return;
        }

        if (projectileData.proxSafety * 1000 + createTime > time.time) {
            // Prox safety is still active. Do not collide.
            return;
        }

        const self = entities.get(uuid);
        if (!self) {
            console.warn(`Missing projectile ${uuid} that is colliding`);
            return;
        }

        emitNow(DamagedEvent, { damage: projectileData.damage, damager: uuid }, [collision.other]);

        if (!collision.initiator) {
            // We are hit by point defense
            return;
        }

        fireSubs(projectileData.id, uuid, false);
        entities.delete(uuid);
        emitNow(ProjectileCollisionEvent, {
            otherUuid: other.uuid,
            position: Position.fromVectorLike(
                self.components.get(MovementStateComponent)?.position ?? new Position(0, 0)
            ),
            projectileData,
        }, [self]);
    }
});

export const ProjectileExplodeEventType = t.intersection([
    t.type({
        position: PositionType,
        projectileData: passthroughType<ProjectileWeaponData>('ProjectileExplodeProjectileData'),
    }),
    t.partial({
        otherUuid: t.string,
    }),
]);
export const ProjectileExplodeEvent = new EcsEvent<{
    otherUuid?: string,
    position: Position,
    projectileData: ProjectileWeaponData,
}>('ProjectileExplodeEvent');

registerSimulationBridgeEvent({
    event: ProjectileExplodeEvent,
    includeEntityUuids: false,
});

const ProjectileExplodeSystem = new System({
    name: 'ProjectileExplodeSystem',
    events: [ProjectileExpireEvent, ProjectileCollisionEvent],
    args: [ProjectileDataComponent, MovementStateComponent, Optional(ProjectileCollisionEvent),
        GetEntity, Emit] as const,
    step(projectileData, movement, collision, self, emit) {
        const position = Position.fromVectorLike(movement.position);
        if (collision) {
            emit(ProjectileExplodeEvent, {
                otherUuid: collision.otherUuid,
                position,
                projectileData,
            }, [self]);
            return;
        }
        if (projectileData.detonateWhenShotExpires) {
            emit(ProjectileExplodeEvent, {
                position,
                projectileData,
            }, [self]);
        }
    }
});

const ProjectileBlastSystem = new System({
    name: 'ProjectileBlastSystem',
    events: [ProjectileExplodeEvent],
    args: [ProjectileDataComponent, ProjectileBlastHull, CollisionHitterComponent,
        MovementStateComponent, Optional(OwnerComponent), Entities,
        IdFactoryResource, ProjectileExplodeEvent] as const,
    step(projectileData, blastHull, hitter, movement, owner, entities, ids, explosion) {
        const blastIgnore = new Set<string>();
        // TODO: Tag ship that was hit as immune to explosion, since it's already hit.
        if (!projectileData.blastHurtsFiringShip && owner) {
            // TODO: Compute this accounting for subs, escorts, etc.
            blastIgnore.add(owner.owner);
            // const projectile
            // blast.components.set(BlastIgnoreComponent,
            //                      new Set([projectile.]));
        }

        if (explosion.otherUuid) {
            // The projectile already damaged this entity, so
            // the blast should ignore it.
            blastIgnore.add(explosion.otherUuid);
        }

        const damage = projectileData.damage;
        const blast = new Entity(`${projectileData.name} Blast`)
            .addComponent(BlastDamageComponent, damage)
            .addComponent(BlastIgnoreComponent, blastIgnore)
            .addComponent(HurtboxHullComponent, blastHull)
            .addComponent(CollisionHitterComponent, hitter)
            .addComponent(MovementStateComponent, {
                position: movement.position,
                accelerating: 0,
                rotation: new Angle(0),
                turning: 0,
                turnBack: false,
                velocity: new Vector(0, 0),
            });
        entities.set(ids.next('blast'), blast);
    }
});

const ProjectileDeathSystem = new System({
    name: 'ProjectileDeathSystem',
    events: [ZeroArmorEvent],
    args: [Entities, UUID, ZeroArmorEvent, ProjectileComponent] as const,
    step(entities, uuid) {
        entities.delete(uuid);
    }
});

export const ProjectilePlugin: Plugin = {
    name: 'ProjectilePlugin',
    build(world) {
        const weaponConstructors = world.resources.get(WeaponConstructors);
        if (!weaponConstructors) {
            throw new Error('Expected WeaponConstructors to exist');
        }
        world.resources.get(SerializerResource)?.addComponent(
            ProjectileDataComponent, passthroughType<ProjectileWeaponData>('ProjectileDataComponentType'));
        world.resources.get(SerializerResource)?.addComponent(ProjectileComponent, t.intersection([
            t.type({ id: t.string }),
            t.partial({ source: t.string }),
        ]));
        world.resources.get(SerializerResource)?.addEvent(ProjectileCollisionEvent, ProjectileCollisionEventType);
        world.resources.get(SerializerResource)?.addEvent(ProjectileExplodeEvent, ProjectileExplodeEventType);
        weaponConstructors.set('ProjectileWeaponData', ProjectileWeaponEntry);

        world.addSystem(ProjectileGuidanceSystem);
        world.addSystem(ProjectileLifespanSystem);
        world.addSystem(ProjectileCollisionSystem);
        world.addSystem(ProjectileDeathSystem);
        world.addSystem(ProjectileHurtboxProvider);
        world.addSystem(ProjectileExplodeSystem);
        world.addSystem(ProjectileBlastSystem);
    }
}
