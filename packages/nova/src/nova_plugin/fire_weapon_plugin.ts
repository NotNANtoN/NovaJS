import * as t from 'io-ts';
import { Animation } from 'novadatainterface/animation';
import { Gettable } from 'novadatainterface/gettable';
import { WeaponData } from 'novadatainterface/weapon_data';
import { Emit, EmitFunction, Entities, GetEntity, RunQuery, RunQueryFunction, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Random, RandomResource } from 'nova_ecs/plugins/random_plugin';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { IdFactory, IdFactoryResource } from './id_factory.js';
import { EntityMap } from 'nova_ecs/entity_map';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementState, MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { markerType, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { Time, TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Provide } from 'nova_ecs/provide';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { DefaultMap } from 'nova_ecs/utils';
import { SingletonComponent } from 'nova_ecs/world';
import { AnimationComponent } from './animation_plugin.js';
import { ExplodingComponent } from './death_plugin.js';
import { applyExitPoint, closestExitPointIndex, ExitPointData, getExitPointData } from './exit_point.js';
import { FiringGroup, FiringGroupComponent } from './firing_group.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { GovtComponent } from './govt_component.js';
import { firstOrderWithFallback } from './guidance.js';
import { TargetComponent } from './target_component.js';
import { WeaponsStateComponent } from './weapons_state.js';

export const WeaponConstructors = new Resource<Map<WeaponData['type'],
    { new(data: WeaponData, runQuery: RunQueryFunction): WeaponEntry }>>('WeaponConstructors');

export const WeaponEntries = new Resource<Gettable<WeaponEntry | undefined>>('WeaponEntries');

type FireSubs = (id: string, source: string, sourceExpired?: boolean) => Entity[];
export const FireSubs = new Resource<FireSubs>('FireSubs');

export const SubCounts = new Component<DefaultMap<string, number>>('SubCount');

export interface WeaponLocalState {
    lastFired: number,
    burstCount: number,
    reloadingBurst: boolean,
    wasFiring: boolean,
    exitIndex: number,
}
type WeaponsLocalState = DefaultMap<string, WeaponLocalState>;
export const WeaponsComponent = new Component<WeaponsLocalState>('WeaponsComponent')
export function defaultWeaponLocalState(): WeaponLocalState {
    return {
        lastFired: 0,
        burstCount: 0,
        reloadingBurst: false,
        wasFiring: false,
        exitIndex: 0,
    };
}
// TODO: This doesn't update if the set or count of weapons changes.
export const WeaponsComponentProvider = Provide({
    name: "WeaponsComponentProvider",
    provided: WeaponsComponent,
    update: [WeaponsStateComponent],
    args: [WeaponsStateComponent] as const,
    factory() {
        return new DefaultMap(defaultWeaponLocalState);
    }
});

/**
 * Picks the exit point this shot leaves the ship from, and advances the
 * weapon's round-robin cursor.
 *
 * Normally a ship cycles through the exit points of the weapon's
 * `exitType` one shot at a time. A weapon with wëap Flags3 0x0010
 * (`firesFromClosestToTarget` — the Ion Cannons) instead fires from
 * whichever exit point is closest to the target, when it has one; with
 * no target it falls back to the round-robin cursor.
 *
 * `targetPosition` is the firer's current target's position, or
 * undefined when it has none. All of this is simulation state (the
 * spawned shot's position), so the choice is pure geometry over
 * replicated state — see closestExitPointIndex.
 *
 * Seam: a point-defense weapon picks its own victim later in
 * fireFromEntity, so a PD weapon carrying the flag would aim from the
 * exit point nearest the ship's SELECTED target rather than the PD
 * victim. No stock weapon is both (only the two Ion Cannons set the
 * flag, and they are beamTurrets), and the selected target is
 * replicated either way, so this stays deterministic.
 */
export function getNextExitpoint(sourceMovement: MovementState, sourceAnimation: Animation,
    weapon: WeaponData, localState: WeaponLocalState,
    targetPosition?: Position) {
    let exitPoint = sourceMovement.position;
    let exitPointData: ExitPointData = {
        position: [0, 0, 0],
        upCompress: [0, 0],
        downCompress: [0, 0],
    }
    if (weapon.exitType !== "center") {
        const exitPoints = sourceAnimation.exitPoints;
        const offset = exitPoints[weapon.exitType];
        // A shän can define no exit points at all for this weapon's
        // class, in which case there is nothing to pick from and the
        // shot leaves from the ship's centre. Skipping the whole block
        // (rather than falling through it) is what keeps `% 0` from
        // writing NaN into exitIndex: that cursor is replicated,
        // wire-serialized state, and JSON turns NaN into null, so a
        // peer restoring the snapshot would not agree with the
        // incumbents about it.
        if (offset.length > 0) {
            if (weapon.firesFromClosestToTarget && targetPosition) {
                localState.exitIndex = closestExitPointIndex(
                    offset, exitPoints, sourceMovement.position,
                    sourceMovement.rotation, targetPosition);
            } else {
                localState.exitIndex =
                    ((localState.exitIndex ?? 0) + 1) % offset.length;
            }

            exitPointData = getExitPointData(sourceAnimation, weapon, localState);
            exitPoint = exitPoint.add(
                applyExitPoint(exitPointData, sourceMovement.rotation)
            ) as Position;
        }
    }

    return { exitPoint, exitPointData };
}

/**
 * The movement state of a target that can still be aimed at, or
 * undefined when there is nothing left to aim at.
 *
 * A TargetComponent holds a uuid, and that uuid outlives what it names.
 * The target's entity can be deleted mid-tick (it jumped out, was
 * captured, was cleaned up by its own death AI) while every
 * TargetComponent naming it still says so: DeleteEvent is QUEUED, so
 * TargetRemovedSystem does not clear those references until the current
 * event finishes, and a rollback restore drops the queued DeleteEvent
 * entirely (World.clearEventQueue). An exploding target is the same
 * situation a beat earlier — it still exists, with a position, but it is
 * a fireball rather than something to shoot at, and every lock on it
 * breaks (DropExplodingTargetSystem) on a tick boundary that firing code
 * must not straddle.
 *
 * Resolving through here rather than trusting the uuid means aiming
 * asks "is there something there?" instead of "was there something
 * there?". Deterministic: entity existence, ExplodingComponent and
 * MovementStateComponent are all replicated simulation state, so every
 * peer answers this identically for a given tick.
 */
export function liveTargetMovement(entities: EntityMap,
    target: string | undefined): MovementState | undefined {
    if (target === undefined) {
        return undefined;
    }
    const entity = entities.get(target);
    if (!entity || entity.components.has(ExplodingComponent)) {
        return undefined;
    }
    return entity.components.get(MovementStateComponent);
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

export function sampleInaccuracy(accuracy: number, random: Random) {
    return 2 * (random.next() - 0.5) * accuracy * (2 * Math.PI / 360);
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

function getRandomInCone(angle: number, count: number, random: Random) {
    const angles: Angle[] = [];
    for (let i = 0; i < count; i++) {
        angles[i] = new Angle((2 * random.next() - 1) * angle);
    }
    return angles;
}

export const SourceComponent = new Component<string>('Source');
// TODO: Fix delta system to allow stuff that isn't an object.
const OwnerComponentType = t.type({owner: t.string});
type OwnerComponentType = t.TypeOf<typeof OwnerComponentType>;
export const OwnerComponent = new Component<OwnerComponentType>('Owner');

const FireFromEntityQuery = new Query([Optional(WeaponsComponent),
    Entities, MovementStateComponent, AnimationComponent, UUID,
Optional(OwnerComponent), Optional(TargetComponent), GetEntity] as const, 'FireFromEntityQuery');

const SubsQuery = new Query([WeaponEntries, MovementStateComponent, Optional(SubCounts),
    Optional(OwnerComponent), Optional(TargetComponent), GetEntity] as const);

const ConstructorQuery = new Query([Entities, Emit, WeaponEntries,
    RandomResource, IdFactoryResource, TimeResource,
    SingletonComponent] as const);

export const VulnerableToPD = new Component<undefined>('VulnerableToPD');
const PointDefenseQuery = new Query([MovementStateComponent, Optional(OwnerComponent),
    UUID, Optional(TargetComponent), VulnerableToPD] as const);

export abstract class WeaponEntry {
    protected entities: EntityMap;
    protected emit: EmitFunction;
    protected random: Random;
    protected ids: IdFactory;
    /**
     * The world's live simulation clock. Held as a reference, exactly
     * like `entities` and `random` above: TimeSystem mutates the Time
     * object in place and the snapshot policy restores it with
     * Object.assign, so the identity never changes and this always
     * reads the CURRENT tick. Weapon spawning needs it because locking
     * a guided missile on a ship is a timestamped act of war
     * (provokeGuidedLock).
     */
    protected time: Time;
    protected abstract pointDefenseRangeSquared: number;
    constructor(public data: WeaponData, protected runQuery: RunQueryFunction) {
        let weaponEntries: Gettable<WeaponEntry | undefined>;
        [this.entities, this.emit, weaponEntries, this.random, this.ids,
            this.time] = runQuery(ConstructorQuery)[0];
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

    /**
     * Spawns one shot. `silent` suppresses this shot's firing sound
     * without changing anything else about it — see fireSubs, which uses
     * it so a submunition burst is heard once rather than once per child.
     * Purely an output concern: SoundEvent carries no simulation state,
     * so silencing a shot cannot move the sim.
     */
    abstract fire(position: Position, angle: Angle, owner?: string,
        target?: string, source?: string, sourceVelocity?: Vector,
        exitPointData?: ExitPointData, silent?: boolean): Entity | undefined;

    /**
     * Stamps a spawned weapon entity (projectile, beam, bay fighter,
     * submunition) with the firer's firing group so its hits are
     * filtered by the friendly-fire pair predicate (see
     * firing_group.ts). The group is the firer's own group when it has
     * one (fleet members, bay fighters, parent projectiles), else the
     * firer's owner-chain root; the govt rides along for the (disabled)
     * same-govt immunity clause.
     */
    protected stampFiringGroup(spawned: Entity, firer: Entity,
        ownerUuid: string) {
        const inherited = firer.components.get(FiringGroupComponent);
        const group = inherited?.group ?? ownerUuid;
        const govt = inherited?.govt
            ?? firer.components.get(GovtComponent)?.id;
        const firingGroup: FiringGroup =
            govt === undefined ? { group } : { group, govt };
        spawned.components.set(FiringGroupComponent, firingGroup);
    }

    fireFromEntity(source: string, inaccuracy = true): Entity | undefined {
        // TODO: This is expensive. Cache queries for different sources in nova_ecs or
        // add a 'number of shots' argument.
        const results = this.runQuery(FireFromEntityQuery, source);
        if (!results[0]) {
            return undefined;
        }
        let [weapons, entities, movement, animation, uuid, owner, targetVal, entity] = results[0];
        if (!owner) {
            owner = {owner: uuid};
        }
        let target = targetVal?.target;
        if (!weapons) {
            weapons = new DefaultMap(() => ({
                lastFired: 0,
                burstCount: 0,
                reloadingBurst: false,
                wasFiring: false,
                exitIndex: 0,
            }));
            entity.components.set(WeaponsComponent, weapons);
        }

        const weapon = weapons.get(this.data.id);

        // Resolved BEFORE the exit point is chosen: a weapon with wëap
        // Flags3 0x0010 fires from the exit point nearest the target.
        const targetMovement = liveTargetMovement(entities, target);

        const { exitPoint, exitPointData } = getNextExitpoint(
            movement, animation, this.data, weapon, targetMovement?.position);

        let angle = movement.rotation;
        if ('guidance' in this.data) {
            // Gated on the target STILL BEING THERE, not on the target
            // uuid being set. A turret aims with targetMovement below and
            // silently keeps `angle` — the ship's own heading — when it
            // resolves to nothing, so a lock naming a destroyed ship used
            // to fire one full-strength shot straight out of the nose:
            // visible, and damaging whatever happened to be in front.
            // Nothing to aim at means nothing fires, exactly as if the
            // ship had never had a target.
            if (!targetMovement && (this.data.guidance === 'beamTurret'
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

        if (inaccuracy) {
            angle = angle.add(sampleInaccuracy(this.data.accuracy, this.random));
        }

        const spawned = this.fire(exitPoint, angle, owner.owner ?? source,
            target, source, movement.velocity, exitPointData);
        if (spawned) {
            this.stampFiringGroup(spawned, entity, owner.owner);
        }
        return spawned;
    }

    fireSubs(source: string, sourceExpired = false, position?: Position): Entity[] {
        let [weaponEntries, movement, subCounts, owner, target, sourceEntity]
            = this.runQuery(SubsQuery, source)[0];
        if (!('submunitions' in this.data)) {
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
        for (const sub of this.data.submunitions) {
            if (subCounts.get(sub.id) > sub.limit) {
                continue;
            }

            const angles = sub.theta < 0
                ? getEvenlySpacedAngles(Math.abs(sub.theta), sub.count)
                : getRandomInCone(sub.theta, sub.count, this.random);

            const subWeapon = weaponEntries.getCached(sub.id);
            if (!subWeapon) {
                continue;
            }
            if (!sub.subIfExpire && sourceExpired) {
                continue;
            }

            // One firing sound for the whole burst, not one per child: a
            // wëap that submunitions into a dozen rockets stacked a dozen
            // copies of the same sample on the same frame, which is just
            // loud. Tracked per SUBMUNITION ENTRY rather than per
            // fireSubs call so a projectile that subs into two different
            // weapons still plays each of their sounds once; and kept as
            // a local, so a sub that itself submunitions gets its own
            // fresh tracker and each generation is heard once.
            //
            // Deliberately NOT hoisted to "once per weapon per frame":
            // a burst weapon firing N shots over N frames must still be
            // heard N times, and each of those is a separate fire call.
            let soundPlayed = false;
            for (let i = 0; i < sub.count; i++) {
                const angle = angles[i] || new Angle(0);
                const subEntity = subWeapon.fire(position ?? movement.position,
                    movement.rotation.add(angle), owner.owner,
                    target?.target, source, undefined, undefined,
                    /* silent */ soundPlayed);
                if (subEntity) {
                    // Keyed off an actual spawn, so a first child that
                    // fails to spawn does not swallow the burst's sound.
                    soundPlayed = true;
                    subs.push(subEntity);
                    this.stampFiringGroup(subEntity, sourceEntity,
                        owner.owner);
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
        const gameData = world.resources.get(SimulationGameDataResource);
        if (!gameData) {
            throw new Error('Expected SimulationGameDataResource to exist');
        }

        const runQuery = world.resources.get(RunQuery);
        if (!runQuery) {
            throw new Error('Expected RunQuery to exist');
        }

        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected DeltaMaker to exist');
        }
        deltaMaker.addComponent(VulnerableToPD, {
            componentType: markerType,
        });

        deltaMaker.addComponent(OwnerComponent, {
            componentType: OwnerComponentType,
        });

        // Firing groups are simulation state (weapon hits depend on
        // them), so they are serializer-registered: hashed for desync
        // detection, snapshotted for rollback, carried on the wire.
        deltaMaker.addComponent(FiringGroupComponent, {
            componentType: FiringGroup,
        });

        // SourceComponent must be serializer-registered to reach the
        // DISPLAY world at all. SimulationBridgeHost.snapshot() encodes
        // only the components the serializer knows
        // (`serializer.hasComponent`), so an unregistered component is
        // silently dropped from every simulation frame — and a display
        // system that queries it then matches NOTHING, with no error
        // anywhere. This is the same class of bug CreateTime had (see
        // create_time.ts); here it broke two display consumers:
        //   - hail_dialog_plugin's bay-fighter test
        //     (`components.has(SourceComponent)`) was always false, so a
        //     player-launched bay fighter was mislabelled "Hired Escort:"
        //     with escort-management buttons it has no state for.
        //   - ship_animation_plugin's ActiveBeamsQuery
        //     ([SourceComponent, BeamDataComponent]) could never match,
        //     so a ship's weapon glow dropped as soon as the fire key was
        //     released instead of lasting the beam's shot duration.
        // It is NOT registered through deltaMaker: DeltaMaker's default
        // delta path drafts component data with immer, which needs an
        // objectish value, and this component holds a bare string.
        // Serializer registration is all the bridge (and the wire/hash
        // paths) needs.
        //
        // Registration does not change rollback-snapshot or wire-snapshot
        // behaviour: configureSnapshotPolicies sets SourceComponent's
        // policy ('share') and wire codec (passthroughWire<string>())
        // explicitly, and explicit entries are consulted BEFORE the
        // serializer-registered default (snapshot_plugin's
        // snapshotComponents / wireSnapshotComponents).
        //
        // The serializer resource is guaranteed here: DeltaResource above
        // is required, and DeltaPlugin builds SerializerPlugin.
        const serializer = world.resources.get(SerializerResource);
        if (!serializer) {
            throw new Error('Expected a serializer to register SourceComponent');
        }
        serializer.addComponent(SourceComponent, t.string);

        world.addSystem(WeaponsComponentProvider);
        world.addComponent(WeaponsComponent);
        world.addComponent(OwnerComponent);
        world.addComponent(SourceComponent);
        world.addComponent(FiringGroupComponent);
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
