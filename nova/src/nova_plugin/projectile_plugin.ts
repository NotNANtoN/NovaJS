import { ProjectileWeaponData, WeaponData } from 'novadatainterface/WeaponData';
import { Emit, EmitNow, Entities, GetEntity, RunQueryFunction, UUID } from 'nova_ecs/arg_types';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import {
    advanceMovementState,
    GuidanceTargetTrackComponent,
    MovementPhysicsComponent,
    MovementStateComponent,
    MovementType,
    MovementSystem,
    queueGuidanceTargetSnapshot,
    REMOTE_INTERPOLATION_DELAY_MS,
    RemoteMovementPresentationComponent,
    RemoteMovementPresentationSystem,
    sampleGuidanceTarget,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { ProvideAsync } from "nova_ecs/provide_async";
import { Query } from "nova_ecs/query";
import { System } from 'nova_ecs/system';
import * as SAT from "sat";
import { v4 } from 'uuid';
import { FactoryQueue } from '../common/factory_queue';
import { AnimationComponent } from './animation_plugin';
import { BlastDamageComponent, BlastIgnoreComponent } from './blast_plugin';
import { CompositeHull, hullFromAnimation, HurtboxHullComponent } from './collisions_plugin';
import { CollisionEvent, CollisionHitterComponent, CollisionVulnerabilityComponent } from './collision_interaction';
import { CreateTime } from './create_time';
import { DamagedEvent, ZeroArmorEvent } from './death_plugin';
import { reserveEntity } from './entity_budget';
import { ExitPointData } from './exit_point';
import { AttackIntentComponent, FireSubs, OwnerComponent, ShotCreation, ShotSeedComponent, SourceComponent, SubCounts, VulnerableToPD, WeaponConstructors, WeaponEntry, setAttackIntent } from './fire_weapon_plugin';
import { GameDataResource } from './game_data_resource';
import { firstOrderWithFallback, Guidance, GuidanceComponent } from './guidance';
import { PlatformResource } from './platform_plugin';
import { ArmorComponent, ShieldComponent } from './health_plugin';
import { ProjectileBlastHull, ProjectileComponent, ProjectileDataComponent } from './projectile_data';
import { ReturnToQueueComponent } from './return_to_queue_plugin';
import { SoundEvent } from './sound_event';
import { Stat } from './stat';
import { TargetComponent } from './target_component';

const SourceOwnershipQuery = new Query([
    Optional(MultiplayerData),
    Optional(SourceComponent),
] as const);

function isPlayerOwnedSource(
    source: string | undefined,
    runQuery: RunQueryFunction,
    visited = new Set<string>(),
): boolean {
    if (!source || visited.has(source)) {
        return false;
    }
    visited.add(source);

    const result = runQuery(SourceOwnershipQuery, source)[0];
    if (!result) {
        return false;
    }
    const [multiplayer, parentSource] = result;
    if (multiplayer) {
        return multiplayer.owner !== 'server';
    }
    return isPlayerOwnedSource(parentSource, runQuery, visited);
}

class ProjectileWeaponEntry extends WeaponEntry {
    declare data: ProjectileWeaponData;
    private factoryQueue: FactoryQueue<Entity>;
    protected pointDefenseRangeSquared: number;

    constructor(data: WeaponData, runQuery: RunQueryFunction) {
        if (data.type !== 'ProjectileWeaponData') {
            throw new Error('Data must be ProjectileWeaponData');
        }
        super(data, runQuery);

        this.pointDefenseRangeSquared = (data.physics.speed * data.shotDuration / 1000) ** 2;

        const queueHolder = {} as { queue: FactoryQueue<Entity> };

        let hitTypes = new Set(['normal']);
        if (data.guidance === 'pointDefense') {
            hitTypes = new Set(['pointDefense']);
        }

        this.factoryQueue = new FactoryQueue(() => {
            const projectile = new Entity(this.data.name)
                .addComponent(ProjectileDataComponent, this.data)
                .addComponent(ProjectileComponent, { id: this.data.id })
                .addComponent(AnimationComponent, this.data.animation)
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
                    hitTypes,
                }).addComponent(ReturnToQueueComponent, queueHolder);

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
        }, 16);
        queueHolder.queue = this.factoryQueue;
    }

    fire(position: Position, angle: Angle, owner?: string, target?: string,
        source?: string, sourceVelocity?: Vector, _exitPointData?: ExitPointData,
        shot?: ShotCreation): Entity | undefined {
        if (!shot) {
            throw new Error('Projectile shots require deterministic creation data');
        }

        let velocity = new Vector(0, 0);
        if (this.data.guidance !== 'guided' && sourceVelocity) {
            velocity = velocity.add(sourceVelocity);
        }
        if (this.data.guidance !== 'rocket') {
            velocity = velocity.add(angle.getUnitVector()
                .scale(this.data.physics.speed));
        }

        if (shot.entityId && this.entities.has(shot.entityId)) {
            return this.entities.get(shot.entityId);
        }

        const projectile = this.factoryQueue.dequeue();
        if (!projectile) {
            return undefined;
        }

        const movementState = projectile.components.get(MovementStateComponent)!;
        movementState.position = position;
        movementState.rotation = angle;
        movementState.velocity = velocity;
        movementState.turning = 0;
        movementState.turnTo = null;

        projectile.components.set(CreateTime, shot.createdAt);
        projectile.components.delete(SubCounts);
        projectile.components.set(ShotSeedComponent, { seed: shot.seed });

        if (target) {
            projectile.components.set(TargetComponent, { target });
        } else {
            projectile.components.delete(TargetComponent);
        }
        setAttackIntent(projectile, target);

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

        if (shot.fastForwardMs > 0) {
            const physics = projectile.components.get(MovementPhysicsComponent)!;
            const guidance = projectile.components.get(GuidanceComponent);
            const targetEntity = target
                ? this.entities.get(target)
                : undefined;
            const onStep = guidance && targetEntity
                ? (state: typeof movementState, _stepSeconds: number,
                    elapsedSeconds: number) => {
                    const targetMovement = sampleGuidanceTarget(
                        targetEntity,
                        shot.createdAt + elapsedSeconds * 1000
                            - REMOTE_INTERPOLATION_DELAY_MS,
                        this.entities,
                    );
                    if (targetMovement) {
                        state.turnTo = firstOrderWithFallback(
                            state.position,
                            state.velocity,
                            targetMovement.position,
                            targetMovement.velocity,
                            this.data.shotSpeed,
                        );
                    }
                }
                : undefined;
            Object.assign(movementState, advanceMovementState(
                movementState,
                physics,
                shot.fastForwardMs / 1000,
                this.entities,
                onStep,
            ));
        }

        const playerOwned = isPlayerOwnedSource(source, this.runQuery);
        if (!reserveEntity(this.budget, projectile, 'projectile', playerOwned)) {
            // The object came from a reusable queue, so return it without
            // retaining a budget reservation when the classic cap is full.
            this.factoryQueue.enqueue(projectile);
            return undefined;
        }
        this.entities.set(shot.entityId ?? v4(), projectile);
        if (this.data.sound && (!shot || shot.fastForwardMs <= 250)) {
            this.emit(SoundEvent, {
                id: this.data.sound,
                loop: this.data.loopSound,
                position: {
                    x: movementState.position.x,
                    y: movementState.position.y,
                },
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

const RecordGuidanceTrackSystem = new System({
    name: 'RecordGuidanceTrackSystem',
    args: [MovementStateComponent,
        Optional(RemoteMovementPresentationComponent),
        Optional(MultiplayerData), TimeResource, PlatformResource,
        GetEntity] as const,
    after: [MovementSystem, RemoteMovementPresentationSystem],
    step(movement, presentation, multiplayer, time, platform, entity) {
        if (presentation) {
            return;
        }
        if (platform === 'node' && multiplayer?.owner
            && multiplayer.owner !== 'server') {
            return;
        }
        let track = entity.components.get(GuidanceTargetTrackComponent);
        if (!track) {
            track = { snapshots: [] };
            entity.components.set(GuidanceTargetTrackComponent, track);
        }
        queueGuidanceTargetSnapshot(track, movement, time.time);
    },
});

const ProjectileGuidanceSystem = new System({
    name: 'ProjectileGuidanceSystem',
    args: [MovementStateComponent, TargetComponent,
        Entities, ProjectileDataComponent, TimeResource] as const,
    before: [MovementSystem],
    step(movementState, { target }, entities, projectileData, time) {
        if (!target) {
            return;
        }
        const targetEntity = entities.get(target);
        if (!targetEntity) {
            return;
        }
        const targetMovement = sampleGuidanceTarget(
            targetEntity,
            time.time - REMOTE_INTERPOLATION_DELAY_MS,
            entities,
        );
        if (!targetMovement) {
            return;
        }

        movementState.turnTo = firstOrderWithFallback(movementState.position, movementState.velocity,
            targetMovement.position, targetMovement.velocity, projectileData.shotSpeed)
    }
});

export const ProjectileCollisionEvent
    = new EcsEvent<Entity>('ProjectileCollision');

const ProjectileHurtboxProvider = ProvideAsync({
    name: "ProjectileHurtboxProvider",
    provided: HurtboxHullComponent,
    args: [AnimationComponent, GameDataResource, CollisionHitterComponent, ProjectileComponent] as const,
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
        emitNow(ProjectileCollisionEvent, other, [self]);
    }
});

export const ProjectileExplodeEvent = new EcsEvent<Entity | undefined>('ProjectileExplodeEvent');

const ProjectileExplodeSystem = new System({
    name: 'ProjectileExplodeSystem',
    events: [ProjectileExpireEvent, ProjectileCollisionEvent],
    args: [ProjectileDataComponent, Optional(ProjectileCollisionEvent),
        GetEntity, Emit] as const,
    step(projectileData, other, self, emit) {
        if (other) {
            emit(ProjectileExplodeEvent, other, [self]);
            return;
        }
        if (projectileData.detonateWhenShotExpires) {
            emit(ProjectileExplodeEvent, undefined, [self]);
        }
    }
});

const ProjectileBlastSystem = new System({
    name: 'ProjectileBlastSystem',
    events: [ProjectileExplodeEvent],
    args: [ProjectileDataComponent, ProjectileBlastHull, CollisionHitterComponent,
        MovementStateComponent, Optional(OwnerComponent),
        Optional(SourceComponent), Optional(AttackIntentComponent), Entities,
        ProjectileExplodeEvent] as const,
    step(projectileData, blastHull, hitter, movement, owner, source,
        attackIntent, entities, other) {
        const blastIgnore = new Set<string>();
        // TODO: Tag ship that was hit as immune to explosion, since it's already hit.
        if (!projectileData.blastHurtsFiringShip && owner) {
            // TODO: Compute this accounting for subs, escorts, etc.
            blastIgnore.add(owner.owner);
            // const projectile
            // blast.components.set(BlastIgnoreComponent,
            //                      new Set([projectile.]));
        }

        if (other) {
            // The projectile already damaged this entity, so
            // the blast should ignore it.
            blastIgnore.add(other.uuid);
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
        if (source) {
            blast.addComponent(SourceComponent, source);
        }
        if (owner) {
            blast.addComponent(OwnerComponent, owner);
        }
        if (attackIntent) {
            blast.addComponent(AttackIntentComponent, attackIntent);
        }
        entities.set(v4(), blast);
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
        weaponConstructors.set('ProjectileWeaponData', ProjectileWeaponEntry);

        world.addSystem(RecordGuidanceTrackSystem);
        world.addSystem(ProjectileGuidanceSystem);
        world.addSystem(ProjectileLifespanSystem);
        world.addSystem(ProjectileCollisionSystem);
        world.addSystem(ProjectileDeathSystem);
        world.addSystem(ProjectileHurtboxProvider);
        world.addSystem(ProjectileExplodeSystem);
        world.addSystem(ProjectileBlastSystem);
    }
}
