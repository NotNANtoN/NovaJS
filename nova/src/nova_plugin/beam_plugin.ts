import { BeamWeaponData, WeaponData } from 'novadatainterface/WeaponData';
import { EmitNow, Entities, RunQuery, RunQueryFunction, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementState, MovementStateComponent, MovementSystem } from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import * as SAT from "sat";
import { v4 } from 'uuid';
import {
    CollisionSystem,
    CompositeHull,
    HitboxHullComponent,
    Hull,
    HurtboxHullComponent,
    UpdateHitboxHullSystem,
    UpdateHurtboxHullSystem,
} from './collisions_plugin';
import {
    CollisionEvent,
    CollisionHitterComponent,
    CollisionVulnerabilityComponent,
} from './collision_interaction';
import { CreateTime, CreateTimeArgProvider } from './create_time';
import { DamagedEvent } from './death_plugin';
import { reserveEntity } from './entity_budget';
import { applyExitPoint, ExitPointData } from './exit_point';
import { FireSubs, OwnerComponent, sampleInaccuracy, SourceComponent, WeaponConstructors, WeaponEntry } from './fire_weapon_plugin';
import { zeroOrderGuidance } from './guidance';
import { SoundEvent } from './sound_event';
import { TargetComponent } from './target_component';
import { WeaponsSystem } from './weapon_plugin';


interface BeamState {
    pointToTarget?: boolean,
    exitPointData?: ExitPointData,
    length?: number,
}

export const BeamStateComponent = new Component<BeamState>('BeamState');
export const BeamDataComponent = new Component<BeamWeaponData>('BeamData');

const BeamSubsQuery = new Query([MovementStateComponent] as const);
const BeamTargetsQuery = new Query([
    HitboxHullComponent,
    UUID,
    CollisionVulnerabilityComponent,
    Optional(OwnerComponent),
] as const);

interface BeamLocalPoint {
    x: number;
    distance: number;
}

const BEAM_CLIP_EPSILON = 1e-9;

function toBeamLocal(x: number, y: number, origin: Position, rotation: Angle): BeamLocalPoint {
    const relativeX = x - origin.x;
    const relativeY = y - origin.y;
    const rightX = Math.cos(rotation.angle);
    const rightY = Math.sin(rotation.angle);
    const forwardX = Math.sin(rotation.angle);
    const forwardY = -Math.cos(rotation.angle);
    return {
        x: relativeX * rightX + relativeY * rightY,
        distance: relativeX * forwardX + relativeY * forwardY,
    };
}

function addBeamClipCandidate(candidates: number[], point: BeamLocalPoint,
    halfWidth: number, length: number) {
    if (point.x < -halfWidth - BEAM_CLIP_EPSILON
        || point.x > halfWidth + BEAM_CLIP_EPSILON
        || point.distance < -BEAM_CLIP_EPSILON
        || point.distance > length + BEAM_CLIP_EPSILON) {
        return;
    }
    candidates.push(Math.max(0, Math.min(length, point.distance)));
}

function addSegmentBoundaryIntersection(candidates: number[],
    a: BeamLocalPoint, b: BeamLocalPoint, coordinate: 'x' | 'distance',
    boundary: number, halfWidth: number, length: number) {
    const aValue = a[coordinate];
    const bValue = b[coordinate];
    const difference = bValue - aValue;
    if (Math.abs(difference) <= BEAM_CLIP_EPSILON) {
        if (Math.abs(aValue - boundary) <= BEAM_CLIP_EPSILON) {
            addBeamClipCandidate(candidates, a, halfWidth, length);
            addBeamClipCandidate(candidates, b, halfWidth, length);
        }
        return;
    }

    const fraction = (boundary - aValue) / difference;
    if (fraction < -BEAM_CLIP_EPSILON || fraction > 1 + BEAM_CLIP_EPSILON) {
        return;
    }
    addBeamClipCandidate(candidates, {
        x: a.x + (b.x - a.x) * fraction,
        distance: a.distance + (b.distance - a.distance) * fraction,
    }, halfWidth, length);
}

/**
 * Find the first point where a target hull intersects the beam's rectangle.
 * The collision system only reports overlap, so this separates the nearest
 * target from other targets that happen to overlap the beam farther away.
 */
function getBeamHitDistance(origin: Position, rotation: Angle, width: number,
    length: number, hull: Hull): number | undefined {
    const halfWidth = width / 2;
    const candidates: number[] = [];

    for (const shape of hull.shapes) {
        if (shape instanceof SAT.Circle) {
            const center = toBeamLocal(shape.pos.x, shape.pos.y, origin, rotation);
            const distanceFromStrip = Math.max(Math.abs(center.x) - halfWidth, 0);
            if (distanceFromStrip > shape.r + BEAM_CLIP_EPSILON) {
                continue;
            }

            const axialRadius = Math.sqrt(Math.max(
                0, shape.r ** 2 - distanceFromStrip ** 2));
            const closestX = Math.max(-halfWidth, Math.min(halfWidth, center.x));
            addBeamClipCandidate(candidates, {
                x: closestX,
                distance: center.distance - axialRadius,
            }, halfWidth, length);
            continue;
        }

        if (!(shape instanceof SAT.Polygon)) {
            continue;
        }

        const points = shape.calcPoints.map(point =>
            toBeamLocal(shape.pos.x + point.x, shape.pos.y + point.y,
                origin, rotation));

        for (const point of points) {
            addBeamClipCandidate(candidates, point, halfWidth, length);
        }
        for (let i = 0; i < points.length; i++) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            for (const boundary of [-halfWidth, halfWidth]) {
                addSegmentBoundaryIntersection(
                    candidates, a, b, 'x', boundary, halfWidth, length);
            }
            for (const boundary of [0, length]) {
                addSegmentBoundaryIntersection(
                    candidates, a, b, 'distance', boundary, halfWidth, length);
            }
        }

        // These cases cover a beam rectangle corner or its origin being
        // inside the target polygon, where no polygon edge crosses a boundary.
        if (SAT.pointInPolygon(new SAT.Vector(origin.x, origin.y), shape)) {
            candidates.push(0);
        }
        for (const x of [-halfWidth, halfWidth]) {
            for (const distance of [0, length]) {
                const rightX = Math.cos(rotation.angle);
                const rightY = Math.sin(rotation.angle);
                const forwardX = Math.sin(rotation.angle);
                const forwardY = -Math.cos(rotation.angle);
                const corner = new SAT.Vector(
                    origin.x + rightX * x + forwardX * distance,
                    origin.y + rightY * x + forwardY * distance,
                );
                if (SAT.pointInPolygon(corner, shape)) {
                    candidates.push(distance);
                }
            }
        }
    }

    if (candidates.length === 0) {
        return undefined;
    }
    return Math.min(...candidates);
}

class BeamWeaponEntry extends WeaponEntry {
    declare data: BeamWeaponData;
    protected pointDefenseRangeSquared: number;

    private hitTypes: Set<string>;
    constructor(data: WeaponData, runQuery: RunQueryFunction) {
        if (data.type !== 'BeamWeaponData') {
            throw new Error('Data must be BeamWeaponData');
        }
        super(data, runQuery);
        this.pointDefenseRangeSquared = data.beamAnimation.length ** 2;

        this.hitTypes = new Set(['normal']);
        if (data.guidance === 'pointDefenseBeam') {
            this.hitTypes = new Set(['pointDefense']);
        }
    }

    protected override guidance(exitPoint: Position, _movement: MovementState,
        targetMovement: MovementState) {
        return zeroOrderGuidance(exitPoint, targetMovement.position);
    }

    fire(position: Position, angle: Angle, owner?: string, target?: string,
        source?: string, _sourceVelocity?: Vector,
        exitPointData?: ExitPointData): Entity | undefined {
        const { width, length } = this.data.beamAnimation;
        const beamPoly = new SAT.Polygon(new SAT.Vector(0, 0), [
            new SAT.Vector(-width / 2, 0),
            new SAT.Vector(-width / 2, -length),
            new SAT.Vector(width / 2, -length),
            new SAT.Vector(width / 2, 0),
        ]);

        const beam = new Entity()
            .setName(this.data.name)
            .addComponent(MovementStateComponent, {
                position,
                rotation: angle,
                velocity: new Vector(0, 0),
                accelerating: 0,
                turnBack: false,
                turning: 0,
            }).addComponent(CollisionHitterComponent, {
                hitTypes: this.hitTypes,
            }).addComponent(HurtboxHullComponent, new CompositeHull([beamPoly])
            ).addComponent(BeamStateComponent, {
                exitPointData,
                pointToTarget: this.data.guidance === "beamTurret" ||
                    this.data.guidance === "pointDefenseBeam",
                length: this.data.beamAnimation.length,
            }).addComponent(BeamDataComponent, this.data);

        if (target) {
            beam.addComponent(TargetComponent, { target });
        }

        if (owner) {
            beam.addComponent(OwnerComponent, {owner});
        }
        if (source) {
            beam.addComponent(SourceComponent, source);
        }

        if (!reserveEntity(this.budget, beam, 'beam')) {
            return undefined;
        }
        this.entities.set(v4(), beam);
        if (this.data.sound) {
            this.emit(SoundEvent, {
                id: this.data.sound,
                loop: this.data.loopSound,
            });
        }
        return beam;
    }

    override fireSubs(source: string, sourceExpired = false) {
        const [{ position, rotation }] = this.runQuery(BeamSubsQuery, source)[0];
        const endOfBeam = position.add(rotation.getUnitVector()
            .scale(this.data.beamAnimation.length)) as Position;
        return super.fireSubs(source, sourceExpired, endOfBeam);
    }
}

export const BeamSystem = new System({
    name: 'BeamSystem',
    before: [UpdateHitboxHullSystem],
    after: [MovementSystem, WeaponsSystem],
    args: [BeamDataComponent, BeamStateComponent, MovementStateComponent, FireSubs,
        CreateTimeArgProvider, TimeResource, UUID, Entities, Optional(SourceComponent),
        Optional(TargetComponent)] as const,
    step(beamData, beamState, movement, fireSubs, fireTime, { time }, uuid,
        entities, source, target) {
        // Recompute clipping every frame so a target that moves out of the
        // beam no longer leaves it permanently shortened.
        beamState.length = beamData.beamAnimation.length;
        const timeSinceFire = time - fireTime;
        if (timeSinceFire > beamData.shotDuration) {
            fireSubs(beamData.id, uuid, true);
            entities.delete(uuid);
        }

        if (source) {
            const parent = entities.get(source);
            const parentMovement = parent?.components
                .get(MovementStateComponent);
            if (parentMovement) {
                movement.position =
                    Position.fromVectorLike(parentMovement.position);
                movement.rotation =
                    Angle.fromAngleLike(parentMovement.rotation);

                if (beamState.exitPointData) {
                    const exitPoint = applyExitPoint(beamState.exitPointData,
                        parentMovement.rotation)

                    movement.position = movement.position.add(exitPoint) as Position;
                }
            }
        }

        if (beamState.pointToTarget && target?.target) {
            const otherPos = entities.get(target.target)?.components
                .get(MovementStateComponent)?.position;
            if (otherPos) {
                movement.rotation = zeroOrderGuidance(movement.position, otherPos);
            }
        }
        movement.rotation = movement.rotation.add(sampleInaccuracy(beamData.accuracy));
    }
});

export const BeamClippingSystem = new System({
    name: 'BeamClippingSystem',
    args: [BeamDataComponent, BeamStateComponent, MovementStateComponent,
        HurtboxHullComponent, Optional(OwnerComponent), RunQuery] as const,
    after: [UpdateHitboxHullSystem, UpdateHurtboxHullSystem],
    before: [CollisionSystem],
    step(beamData, beamState, movement, beamHull, owner, runQuery) {
        const maxLength = Math.max(0, beamData.beamAnimation.length);
        const hitType = beamData.guidance === 'pointDefenseBeam'
            ? 'pointDefense'
            : 'normal';
        let effectiveLength = maxLength;

        for (const [targetHull, targetUuid, vulnerability, targetOwner]
            of runQuery(BeamTargetsQuery)) {
            if (targetUuid === owner?.owner
                || (owner && targetOwner?.owner === owner.owner)
                || !vulnerability.vulnerableTo.has(hitType)
                || !beamHull.collides(targetHull)) {
                continue;
            }

            const hitDistance = getBeamHitDistance(
                movement.position, movement.rotation, beamData.beamAnimation.width,
                maxLength, targetHull);
            if (hitDistance !== undefined) {
                effectiveLength = Math.min(effectiveLength, hitDistance);
            }
        }

        beamState.length = effectiveLength;
    },
});

const BeamCollisionSystem = new System({
    name: 'BeamCollisionSystem',
    events: [CollisionEvent],
    args: [CollisionEvent, Entities, Optional(OwnerComponent),
        BeamDataComponent, BeamStateComponent, MovementStateComponent,
        CreateTime, EmitNow, TimeResource, UUID] as const,
    step(collision, entities, owner, beamData, beamState, movement,
        fireTime, emitNow, { time, delta_ms }, uuid) {

        const other = entities.get(collision.other);
        if (!other) {
            return;
        }
        const otherOwner = other.components.get(OwnerComponent);
        if (collision.other === owner?.owner
            || (owner && otherOwner?.owner === owner.owner)) {
            return;
        }

        // CollisionSystem reports every target overlapped by the full beam.
        // Only the first target should receive damage; later targets are
        // occluded by the clipped beam length.
        const otherHull = other.components.get(HitboxHullComponent);
        if (otherHull) {
            const hitDistance = getBeamHitDistance(
                movement.position, movement.rotation, beamData.beamAnimation.width,
                beamData.beamAnimation.length, otherHull);
            if (hitDistance !== undefined
                && hitDistance > (beamState.length
                    ?? beamData.beamAnimation.length) + BEAM_CLIP_EPSILON) {
                return;
            }
        }

        const timeSinceFire = Math.max(0, time - fireTime);
        const previousTimeSinceFire = Math.max(
            0, timeSinceFire - Math.max(0, delta_ms));
        // Weapon damage is specified per original EV Nova 1/30-second tick.
        // Convert active milliseconds to ticks so damage is independent of
        // the simulation/render frame rate.
        const damageTime = Math.max(0, Math.min(
            timeSinceFire, beamData.shotDuration)
            - Math.min(previousTimeSinceFire, beamData.shotDuration));
        const scale = damageTime * 30 / 1000;
        if (scale === 0) {
            return;
        }

        emitNow(DamagedEvent, { damage: beamData.damage, damager: uuid, scale }, [collision.other]);
    }
});

export const BeamPlugin: Plugin = {
    name: 'BeamPlugin',
    build(world) {
        const weaponConstructors = world.resources.get(WeaponConstructors);
        if (!weaponConstructors) {
            throw new Error('Expected WeaponConstructors to exist');
        }
        weaponConstructors.set('BeamWeaponData', BeamWeaponEntry);

        world.addSystem(BeamSystem);
        world.addSystem(BeamClippingSystem);
        world.addSystem(BeamCollisionSystem);
    }
};
