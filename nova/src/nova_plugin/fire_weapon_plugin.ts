import * as t from 'io-ts';
import { Animation } from 'novadatainterface/Animation';
import { Gettable } from 'novadatainterface/Gettable';
import { WeaponData } from 'novadatainterface/WeaponData';
import { Emit, EmitFunction, Entities, GetEntity, RunQuery, RunQueryFunction, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { EntityMap } from 'nova_ecs/entity_map';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementState, MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Provide } from 'nova_ecs/provide';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { DefaultMap } from 'nova_ecs/utils';
import { SingletonComponent } from 'nova_ecs/world';
import { AnimationComponent } from './animation_plugin';
import { EntityBudget, EntityBudgetResource } from './entity_budget';
import { applyExitPoint, ExitPointData, getExitPointData } from './exit_point';
import { GameDataResource } from './game_data_resource';
import { firstOrderWithFallback } from './guidance';
import { TargetComponent } from './target_component';
import { WeaponsStateComponent } from './weapons_state';
import { ArmorComponent } from './health_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { FireLogShot, fireLogReplayTiming, loggedShotEntityId } from './fire_sync';
import { createShotRng, ShotRng } from './shot_rng';

export const WeaponConstructors = new Resource<Map<WeaponData['type'],
    { new(data: WeaponData, runQuery: RunQueryFunction): WeaponEntry }>>('WeaponConstructors');

export const WeaponEntries = new Resource<Gettable<WeaponEntry | undefined>>('WeaponEntries');

type FireSubs = (id: string, source: string, sourceExpired?: boolean) => Entity[];
export const FireSubs = new Resource<FireSubs>('FireSubs');

export const SubCounts = new Component<DefaultMap<string, number>>('SubCount');

export interface WeaponLocalState {
    /**
     * Fractional firing opportunities carried between simulation steps.
     * Optional so state created by older clients can be upgraded in place.
     */
    shotsOwed?: number,
    burstCount: number,
    reloadingBurst: boolean,
    wasFiring: boolean,
    exitIndex: number,
    /**
     * Set once a simulation step has seen the current press. A press and its
     * release can both arrive from the browser between two steps; without
     * this the whole tap is discarded and no shot is ever fired.
     */
    pressObserved?: boolean,
    /**
     * The trigger was released before any step observed the press. Firing
     * intent is held for exactly one step and then cleared.
     */
    releaseAfterStep?: boolean,
}
export type WeaponsLocalState = DefaultMap<string, WeaponLocalState>;
export const WeaponsComponent = new Component<WeaponsLocalState>('WeaponsComponent')

export function getDefaultWeaponLocalState(): WeaponLocalState {
    return {
        // Preserve the old behavior of allowing a weapon to fire immediately
        // when it is first pressed, while subsequent shots use the accumulator.
        shotsOwed: 1,
        burstCount: 0,
        reloadingBurst: false,
        wasFiring: false,
        exitIndex: 0,
        pressObserved: false,
        releaseAfterStep: false,
    };
}

// TODO: This doesn't update if the set or count of weapons changes.
export const WeaponsComponentProvider = Provide({
    name: "WeaponsComponentProvider",
    provided: WeaponsComponent,
    update: [WeaponsStateComponent],
    args: [WeaponsStateComponent, Optional(WeaponsComponent)] as const,
    factory(_weaponsState, previous) {
        // Reload accumulators, burst counters, and exit-point rotation are
        // per-weapon firing progress. A refreshed WeaponsState (a purchased
        // outfit, or a replicated update) must not silently reload every
        // weapon, which would let a held trigger fire far faster than the
        // weapon's reload allows.
        const localState: WeaponsLocalState =
            new DefaultMap<string, WeaponLocalState>(
                getDefaultWeaponLocalState);
        for (const [id, state] of previous ?? []) {
            localState.set(id, state);
        }
        return localState;
    }
});

function getNextExitpoint(sourceMovement: MovementState, sourceAnimation: Animation,
    weapon: WeaponData, localState: WeaponLocalState,
    requestedExitIndex?: number) {
    let exitPoint = sourceMovement.position;
    let exitIndex = requestedExitIndex ?? localState.exitIndex;
    let exitPointData: ExitPointData = {
        position: [0, 0, 0],
        upCompress: [0, 0],
        downCompress: [0, 0],
    }
    if (weapon.exitType !== "center") {
        const offset = sourceAnimation.exitPoints[weapon.exitType];
        if (requestedExitIndex === undefined) {
            localState.exitIndex =
                ((localState.exitIndex ?? 0) + 1) % offset.length;
            exitIndex = localState.exitIndex;
        } else {
            exitIndex = ((requestedExitIndex % offset.length) + offset.length)
                % offset.length;
        }

        exitPointData = getExitPointData(sourceAnimation, weapon, {
            ...localState,
            exitIndex,
        });
        exitPoint = exitPoint.add(
            applyExitPoint(exitPointData, sourceMovement.rotation)
        ) as Position;
    }

    return { exitPoint, exitPointData, exitIndex };
}

type Quadrant = 'frontQuadrant' | 'sidesQuadrant' | 'rearQuadrant';
function getQuadrant(source: Position, angle: Angle, target: Position): Quadrant {
    const angleToOther = target.subtract(source).angle;
    const relativeAngle = angle.subtract(angleToOther);
    const absAngle = Math.abs(relativeAngle.angle);
    if (absAngle < Math.PI / 4) {
        return 'frontQuadrant';
    } else if (absAngle > 3 * Math.PI / 4) {
        return 'rearQuadrant';
    }
    return 'sidesQuadrant';
}

export function sampleInaccuracy(accuracy: number, rng: ShotRng) {
    return 2 * (rng.next() - 0.5) * accuracy * (2 * Math.PI / 360);
}

/**
 * Returns evenly spaced angles centered around zero with a given spacing
 * inbetween.
 */
export function getEvenlySpacedAngles(spacing: number, count: number) {
    const angles: Angle[] = [];
    let offset: number;
    if (count % 2 === 1) {
        angles.push(new Angle(0));
        offset = spacing;
        count--;
    } else {
        offset = spacing / 2;
    }

    for (let i = 0; i < count / 2; i++) {
        const angle = i * spacing + offset;
        angles.push(new Angle(angle));
        angles.push(new Angle(-angle));
    }
    return angles;
}

export function getRandomInCone(angle: number, count: number, rng: ShotRng) {
    const angles: Angle[] = [];
    for (let i = 0; i < count; i++) {
        angles[i] = new Angle((2 * rng.next() - 1) * angle);
    }
    return angles;
}

export const SourceComponent = new Component<string>('Source');
export const ShotSeedComponent =
    new Component<{ seed: number }>('ShotSeedComponent');
export interface AttackIntent {
    target: string;
}
/**
 * Immutable per-shot targeting evidence. It is intentionally server-local:
 * the authoritative server creates its own shot from the firing ship's
 * accepted TargetComponent and trigger state, so a client cannot attach or
 * rewrite this evidence on an in-flight projectile.
 */
export const AttackIntentComponent =
    new Component<AttackIntent>('AttackIntentComponent');
replicationPolicies.register(AttackIntentComponent, {
    codec: t.type({ target: t.string }),
    authority: 'local-only',
});

export function setAttackIntent(entity: Entity, target?: string): void {
    if (target) {
        entity.components.set(AttackIntentComponent, { target });
    } else {
        entity.components.delete(AttackIntentComponent);
    }
}

export function inheritedAttackTarget(
    currentTarget: string | undefined,
    attackIntent: AttackIntent | undefined,
): string | undefined {
    return attackIntent?.target ?? currentTarget;
}

export function attackOriginLocked(
    destructionStarted: boolean | undefined,
    armorCurrent: number | undefined,
): boolean {
    return Boolean(destructionStarted)
        || armorCurrent !== undefined && armorCurrent <= 0;
}
// TODO: Fix delta system to allow stuff that isn't an object.
const OwnerComponentType = t.type({owner: t.string});
type OwnerComponentType = t.TypeOf<typeof OwnerComponentType>;
export const OwnerComponent = new Component<OwnerComponentType>('Owner');

const FireFromEntityQuery = new Query([Optional(WeaponsComponent),
    Entities, MovementStateComponent, AnimationComponent, UUID,
    Optional(OwnerComponent), Optional(TargetComponent),
    Optional(DestructionStartedComponent), Optional(ArmorComponent),
    GetEntity, TimeResource] as const, 'FireFromEntityQuery');

const SubsQuery = new Query([WeaponEntries, MovementStateComponent, Optional(SubCounts),
    Optional(OwnerComponent), Optional(TargetComponent),
    Optional(AttackIntentComponent), GetEntity, Optional(ShotSeedComponent),
    TimeResource] as const);

const FireLogSourceQuery = new Query([
    MovementStateComponent,
    AnimationComponent,
    Optional(OwnerComponent),
    Optional(TargetComponent),
    Optional(DestructionStartedComponent),
    Optional(ArmorComponent),
] as const, 'FireLogSourceQuery');

const ConstructorQuery = new Query([Entities, Emit, WeaponEntries,
    SingletonComponent, EntityBudgetResource] as const);

export const VulnerableToPD = new Component<undefined>('VulnerableToPD');
const PointDefenseQuery = new Query([MovementStateComponent, Optional(OwnerComponent),
    UUID, Optional(TargetComponent), VulnerableToPD] as const);

export interface ShotCreation {
    seed: number;
    inaccuracy: number;
    createdAt: number;
    fastForwardMs: number;
    entityId?: string;
}

export interface FiredShot {
    entity: Entity;
    position: Position;
    rotation: Angle;
    sourceVelocity: Vector;
    target?: string;
    inaccuracy: number;
}

export abstract class WeaponEntry {
    protected entities: EntityMap;
    protected emit: EmitFunction;
    protected budget: EntityBudget;
    protected abstract pointDefenseRangeSquared: number;
    readonly syncAsFireEvent: boolean = true;
    constructor(public data: WeaponData, protected runQuery: RunQueryFunction) {
        let weaponEntries: Gettable<WeaponEntry | undefined>;
        [this.entities, this.emit, weaponEntries, , this.budget] =
            runQuery(ConstructorQuery)[0];
        if ('submunitions' in this.data) {
            for (const sub of this.data.submunitions) {
                weaponEntries.get(sub.id);
            }
        }
    }

    protected guidance(exitPoint: Position, source: MovementState, target: MovementState) {
        return firstOrderWithFallback(exitPoint, source.velocity, target.position,
            target.velocity, this.data.shotSpeed);
    }

    abstract fire(position: Position, angle: Angle, owner?: string,
        target?: string, source?: string, sourceVelocity?: Vector,
        exitPointData?: ExitPointData,
        shot?: ShotCreation): Entity | undefined;

    fireFromEntity(source: string, seed: number,
        inaccuracy = true, exitIndex?: number): Entity | undefined {
        return this.fireFromEntityDetailed(
            source, seed, inaccuracy, exitIndex)?.entity;
    }

    fireFromEntityDetailed(source: string, seed: number,
        inaccuracy = true, exitIndex?: number): FiredShot | undefined {
        // TODO: This is expensive. Cache queries for different sources in nova_ecs or
        // add a 'number of shots' argument.
        const results = this.runQuery(FireFromEntityQuery, source);
        if (!results[0]) {
            return undefined;
        }
        let [
            weapons,
            entities,
            movement,
            animation,
            uuid,
            owner,
            targetVal,
            destructionStarted,
            armor,
            entity,
            time,
        ] = results[0];
        if (attackOriginLocked(destructionStarted, armor?.current)) {
            return undefined;
        }
        if (!owner) {
            owner = {owner: uuid};
        }
        let target = targetVal?.target;
        let weapon: WeaponLocalState;
        if (exitIndex !== undefined) {
            weapon = {
                ...getDefaultWeaponLocalState(),
                exitIndex,
            };
        } else {
            if (!weapons) {
                weapons = new DefaultMap(getDefaultWeaponLocalState);
                entity.components.set(WeaponsComponent, weapons);
            }
            weapon = weapons.get(this.data.id);
        }
        const { exitPoint, exitPointData } = getNextExitpoint(
            movement, animation, this.data, weapon, exitIndex);

        let targetMovement: MovementState | undefined;
        if (target) {
            targetMovement = entities.get(target)?.components
                .get(MovementStateComponent);
        }

        let angle = movement.rotation;
        if ('guidance' in this.data) {
            if (!target && (this.data.guidance === 'beamTurret'
                || this.data.guidance === 'turret')) {
                return undefined;
            }

            if (this.data.guidance === 'rearQuadrant') {
                angle = angle.add(Math.PI);
            }

            const quadrant = targetMovement
                ? getQuadrant(movement.position, movement.rotation,
                    targetMovement.position)
                : undefined;

            if ((this.data.guidance === quadrant
                || this.data.guidance === 'turret'
                || this.data.guidance === 'beamTurret')
                && targetMovement) {
                angle = this.guidance(exitPoint, movement, targetMovement);
            }

            if (this.data.guidance === 'pointDefense' ||
                this.data.guidance === 'pointDefenseBeam') {
                const targets = this.runQuery(PointDefenseQuery);
                let closest: MovementState | undefined = undefined
                let closestUuid: string | undefined = undefined;
                let distance2 = Infinity;
                for (let [movement, targetOwner, uuid, otherTarget] of targets) {
                    if (!targetOwner) {
                        targetOwner = {owner: uuid};
                    }
                    if (targetOwner === owner) {
                        continue;
                    }
                    if (!(otherTarget?.target === owner.owner
                        || otherTarget?.target === source)) {
                        continue;
                    }
                    const newDistance2 = movement.position.subtract(exitPoint).lengthSquared;
                    if (newDistance2 < distance2) {
                        closest = movement;
                        closestUuid = uuid;
                        distance2 = newDistance2;
                    }
                }

                if (closest && distance2 <= this.pointDefenseRangeSquared) {
                    angle = this.guidance(exitPoint, movement, closest);
                    target = closestUuid;
                } else {
                    return undefined;
                }
            }
            // TODO: Blindspots
        }

        const inaccuracyOffset = inaccuracy
            ? sampleInaccuracy(this.data.accuracy, createShotRng(seed))
            : 0;
        const shot = this.fire(exitPoint, angle.add(inaccuracyOffset),
            owner.owner ?? source, target, source, movement.velocity,
            exitPointData, {
                seed,
                inaccuracy: inaccuracyOffset,
                createdAt: time.time,
                fastForwardMs: 0,
            });
        if (!shot) {
            return undefined;
        }
        const spawned = shot.components.get(MovementStateComponent);
        return {
            entity: shot,
            position: spawned
                ? Position.fromVectorLike(spawned.position)
                : Position.fromVectorLike(exitPoint),
            rotation: spawned
                ? Angle.fromAngleLike(spawned.rotation)
                : angle.add(inaccuracyOffset),
            sourceVelocity: new Vector(movement.velocity.x, movement.velocity.y),
            target,
            inaccuracy: inaccuracyOffset,
        };
    }

    fireFromLog(source: string, shot: FireLogShot,
        now: number): Entity | undefined {
        const duration = 'shotDuration' in this.data
            ? this.data.shotDuration : 0;
        const timing = fireLogReplayTiming(shot.at, now, duration);
        if (timing.expired) {
            return undefined;
        }
        const result = this.runQuery(FireLogSourceQuery, source)[0];
        if (!result) {
            return undefined;
        }
        const [movement, animation, owner, target, destructionStarted, armor] =
            result;
        if (attackOriginLocked(destructionStarted, armor?.current)) {
            return undefined;
        }
        const { exitPointData } = getNextExitpoint(
            movement,
            animation,
            this.data,
            {
                ...getDefaultWeaponLocalState(),
                exitIndex: shot.exitIndex,
            },
            shot.exitIndex,
        );
        const sourceVelocity = shot.sourceVelocity
            ? new Vector(shot.sourceVelocity.x, shot.sourceVelocity.y)
            : movement.velocity;
        return this.fire(
            Position.fromVectorLike(shot.position),
            Angle.fromAngleLike(shot.rotation),
            owner?.owner ?? source,
            shot.target ?? target?.target,
            source,
            sourceVelocity,
            exitPointData,
            {
                seed: shot.seed,
                inaccuracy: shot.inaccuracy ?? 0,
                createdAt: timing.createdAt,
                fastForwardMs: timing.fastForwardMs,
                entityId: loggedShotEntityId(source, shot.seq),
            },
        );
    }

    fireSubs(source: string, sourceExpired = false, position?: Position): Entity[] {
        if (!('submunitions' in this.data)) {
            return [];
        }
        const result = this.runQuery(SubsQuery, source)[0];
        if (!result) {
            return [];
        }
        let [
            weaponEntries,
            movement,
            subCounts,
            owner,
            target,
            attackIntent,
            sourceEntity,
            shotSeed,
            time,
        ] = result;
        if (!shotSeed) {
            return [];
        }
        if (!owner) {
            owner = {owner: source};
            // Does this really need to be set?
            sourceEntity.components.set(OwnerComponent, owner);
        }
        if (!subCounts) {
            subCounts = new DefaultMap(() => 0);
            // Does this really need to be set?
            sourceEntity.components.set(SubCounts, subCounts);
        }

        const subs: Entity[] = [];
        const rng = createShotRng(shotSeed.seed);
        for (const sub of this.data.submunitions) {
            if (subCounts.get(sub.id) > sub.limit) {
                continue;
            }

            const angles = sub.theta < 0
                ? getEvenlySpacedAngles(Math.abs(sub.theta), sub.count)
                : getRandomInCone(sub.theta, sub.count, rng);

            const subWeapon = weaponEntries.getCached(sub.id);
            if (!subWeapon) {
                continue;
            }
            if (!sub.subIfExpire && sourceExpired) {
                continue;
            }

            for (let i = 0; i < sub.count; i++) {
                const angle = angles[i] || new Angle(0);
                const seed = Math.floor(rng.next() * 0x1_0000_0000) >>> 0;
                const subEntity = subWeapon.fire(position ?? movement.position,
                    movement.rotation.add(angle), owner.owner,
                    inheritedAttackTarget(target?.target, attackIntent), source,
                    undefined, undefined, {
                        seed,
                        inaccuracy: 0,
                        createdAt: time.time,
                        fastForwardMs: 0,
                    });
                if (subEntity) {
                    subs.push(subEntity);
                    const newCounts = new DefaultMap(() => 0, subCounts);
                    newCounts.set(sub.id, newCounts.get(sub.id) + 1);
                    subEntity.components.set(SubCounts, newCounts);
                }
            }
        }
        return subs;
    }
}

export const FireWeaponPlugin: Plugin = {
    name: 'FireWeaponPlugin',
    build(world) {
        const gameData = world.resources.get(GameDataResource);
        if (!gameData) {
            throw new Error('Expected GameDataResource to exist');
        }

        const runQuery = world.resources.get(RunQuery);
        if (!runQuery) {
            throw new Error('Expected RunQuery to exist');
        }

        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected DeltaMaker to exist');
        }
        deltaMaker.addComponent(OwnerComponent, {
            componentType: OwnerComponentType,
        });

        world.addSystem(WeaponsComponentProvider);
        world.addComponent(WeaponsComponent);
        // Server-local presence marker used by point-defense targeting.
        // Undefined tuple values become null over JSON, so this must not be
        // registered for delta serialization.
        world.addComponent(VulnerableToPD);
        world.addComponent(OwnerComponent);
        world.addComponent(SourceComponent);
        world.addComponent(ShotSeedComponent);
        world.addComponent(AttackIntentComponent);
        world.resources.set(WeaponConstructors, new Map());
        const weaponConstructors = world.resources.get(WeaponConstructors)!;

        const weaponEntries = new Gettable<WeaponEntry | undefined>(async id => {
            const data = await gameData.data.Weapon.get(id);
            const construct = weaponConstructors.get(data.type);
            if (!construct) {
                return undefined;
            }
            return new construct(data, runQuery);
        });
        world.resources.set(WeaponEntries, weaponEntries);

        world.resources.set(FireSubs, (id: string, source: string,
            sourceExpired?: boolean) => {
            const weaponEntry = weaponEntries.getCached(id);
            if (!weaponEntry) {
                return [];
            }
            return weaponEntry.fireSubs(source, sourceExpired);
        });
    }
}
