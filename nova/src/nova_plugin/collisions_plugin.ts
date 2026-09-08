import { isDraft } from 'immer';
import { Animation } from "novadatainterface/Animation";
import { GameDataInterface } from "novadatainterface/GameDataInterface";
import { Emit, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Angle } from "nova_ecs/datatypes/angle";
import { Vector } from "nova_ecs/datatypes/vector";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { MovementState, MovementStateComponent, MovementSystem, RemoteMovementPresentationSystem, RemoteMovementPresentationComponent } from "nova_ecs/plugins/movement_plugin";
import { TimeResource, TimeSystem } from "nova_ecs/plugins/time_plugin";
import { BOUNDARY } from "nova_ecs/datatypes/position";
import { ProjectileComponent } from './projectile_data';
import { sweptHullTime } from './swept_collision';
import { ProvideAsync } from "nova_ecs/provide_async";
import { Query } from "nova_ecs/query";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import { SingletonComponent } from "nova_ecs/world";
import { init as initNovaWasm, isInitialized as isNovaWasmInitialized, satBatch } from "../../../nova_wasm";
import RBush, { BBox } from "rbush";
import * as SAT from "sat";
import { getFrameFromMovement } from "../util/get_frame_and_angle";
import { AnimationComponent } from "./animation_plugin";
import { CollisionEvent, CollisionHitter, CollisionHitterComponent, CollisionVulnerability, CollisionVulnerabilityComponent } from "./collision_interaction";
import { GameDataResource } from "./game_data_resource";

type Shape = SAT.Polygon | SAT.Circle;

interface PolygonBatchGeometry {
    polygons: SAT.Polygon[];
    vertices: Float32Array;
    offsets: Uint32Array;
}

const polygonBatchGeometry = new WeakMap<Hull, PolygonBatchGeometry>();

function getPolygonBatchGeometry(hull: Hull): PolygonBatchGeometry | undefined {
    if (!hull.shapes.every(shape => shape instanceof SAT.Polygon)) {
        return undefined;
    }

    const polygons = hull.shapes as SAT.Polygon[];
    const cached = polygonBatchGeometry.get(hull);
    if (cached &&
        cached.polygons.length === polygons.length &&
        cached.polygons.every((polygon, index) => polygon === polygons[index])) {
        return cached;
    }

    const vertices: number[] = [];
    const offsets = [0];
    for (const polygon of polygons) {
        for (const point of polygon.points) {
            vertices.push(point.x, point.y);
        }
        offsets.push(vertices.length);
    }

    const geometry = {
        // Copy the collection: a WeakMap does not make its values weak, and
        // hull.shapes can be a revocable draft array on a long-lived hull.
        polygons: [...polygons],
        vertices: new Float32Array(vertices),
        offsets: new Uint32Array(offsets),
    };
    if (!isDraft(hull) && !polygons.some(polygon => isDraft(polygon))) {
        polygonBatchGeometry.set(hull, geometry);
    }
    return geometry;
}

function makePairIndices(aCount: number, bCount: number): Uint32Array {
    const pairs = new Uint32Array(aCount * bCount * 2);
    for (let a = 0; a < aCount; a++) {
        for (let b = 0; b < bCount; b++) {
            const pairIndex = (a * bCount + b) * 2;
            pairs[pairIndex] = a;
            pairs[pairIndex + 1] = b;
        }
    }
    return pairs;
}

// Below this many shape-pair tests, the WASM call overhead (typed array
// allocation + boundary crossing) exceeds the cost of the JS SAT tests.
const RUST_SAT_MIN_PAIRS = 4;

function rustPolygonCollision(hull: Hull, other: Hull): boolean | undefined {
    if (!isNovaWasmInitialized()
        || hull.shapes.length * other.shapes.length < RUST_SAT_MIN_PAIRS) {
        return undefined;
    }

    const geometry = getPolygonBatchGeometry(hull);
    const otherGeometry = getPolygonBatchGeometry(other);
    if (!geometry || !otherGeometry) {
        return undefined;
    }

    const positions = new Float32Array(geometry.polygons.length * 2);
    const rotations = new Float32Array(geometry.polygons.length);
    for (let i = 0; i < geometry.polygons.length; i++) {
        positions[i * 2] = geometry.polygons[i].pos.x;
        positions[i * 2 + 1] = geometry.polygons[i].pos.y;
        rotations[i] = geometry.polygons[i].angle;
    }

    const otherPositions = new Float32Array(otherGeometry.polygons.length * 2);
    const otherRotations = new Float32Array(otherGeometry.polygons.length);
    for (let i = 0; i < otherGeometry.polygons.length; i++) {
        otherPositions[i * 2] = otherGeometry.polygons[i].pos.x;
        otherPositions[i * 2 + 1] = otherGeometry.polygons[i].pos.y;
        otherRotations[i] = otherGeometry.polygons[i].angle;
    }

    try {
        const results = satBatch(
            geometry.vertices,
            geometry.offsets,
            positions,
            rotations,
            otherGeometry.vertices,
            otherGeometry.offsets,
            otherPositions,
            otherRotations,
            makePairIndices(
                geometry.polygons.length,
                otherGeometry.polygons.length,
            ),
        );
        return results.some(result => result !== 0);
    } catch (_error) {
        // A failed WASM call must not disable the existing JS collision path.
        return undefined;
    }
}

export abstract class Hull {
    abstract shapes: Shape[];
    abstract pos: SAT.Vector;
    abstract angle: number;
    abstract readonly bbox: BBox;

    collides(other: Hull) {
        const rustResult = rustPolygonCollision(this, other);
        if (rustResult !== undefined) {
            return rustResult;
        }

        for (const shape of this.shapes) {
            for (const otherShape of other.shapes) {
                if (shape instanceof SAT.Polygon) {
                    if (otherShape instanceof SAT.Polygon &&
                        SAT.testPolygonPolygon(shape, otherShape)) {
                        return true;
                    } else if (otherShape instanceof SAT.Circle &&
                        SAT.testPolygonCircle(shape, otherShape)) {
                        return true;
                    }
                } else {
                    if (otherShape instanceof SAT.Polygon &&
                        SAT.testCirclePolygon(shape, otherShape)) {
                        return true;
                    } else if (otherShape instanceof SAT.Circle &&
                        SAT.testCircleCircle(shape, otherShape)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
}

export class CompositeHull extends Hull {
    private bboxShape: BBox;
    private rotatedBbox?: BBox;
    private cachedBbox?: BBox;
    private cachedBboxAngle?: number;
    private cachedBboxX?: number;
    private cachedBboxY?: number;
    private wrappedAngle = 0;
    private wrappedPos = new SAT.Vector(0, 0);
    constructor(readonly shapes: Shape[]) {
        super();
        this.pos = new SAT.Vector(0, 0); // Set position on shapes
        this.bboxShape = getBoundingBox(shapes);
    }

    set pos(position: SAT.Vector) {
        if (this.pos === position) {
            return;
        }
        for (const shape of this.shapes) {
            shape.pos = position;
        }
        this.wrappedPos = position;
        this.cachedBbox = undefined;
    }

    get pos() {
        return this.wrappedPos;
    }

    set angle(angle: number) {
        if (angle === this.wrappedAngle) {
            return;
        }
        for (const shape of this.shapes) {
            if ('setAngle' in shape) {
                shape.setAngle(angle);
            }
        }
        this.wrappedAngle = angle;
        this.rotatedBbox = undefined;
        this.cachedBbox = undefined;
    }
    get angle() {
        return this.wrappedAngle
    }

    get bbox() {
        const angle = this.angle;
        if (!this.rotatedBbox || this.cachedBboxAngle !== angle) {
            this.rotatedBbox = rotateAabb(this.bboxShape, angle);
            this.cachedBboxAngle = angle;
            this.cachedBbox = undefined;
        }

        const { x, y } = this.pos;
        if (!this.cachedBbox || this.cachedBboxX !== x || this.cachedBboxY !== y) {
            this.cachedBbox = translateAabb(this.rotatedBbox, this.pos);
            this.cachedBboxX = x;
            this.cachedBboxY = y;
        }
        return this.cachedBbox;
    }
}

class MultiFrameHull extends Hull {
    private activeHull: Hull;
    public pos = new SAT.Vector(0, 0);
    private wrappedAngle = 0;
    constructor(private hulls: Hull[]) {
        super();
        this.activeHull = hulls[0];
        this.activeHull.pos = this.pos;
    }
    get shapes() {
        return this.activeHull.shapes;
    }
    get angle() {
        return this.wrappedAngle;
    }
    set angle(angle: number) {
        this.activeHull.angle = angle;
        this.wrappedAngle = angle;
    }
    set frame(frame: number) {
        const newHull = this.hulls[frame];
        if (newHull === this.activeHull) {
            return;
        }
        if (!newHull) {
            console.warn(`Tried to set hull to ${frame} but only ${this.hulls.length} are available`);
            return;
        }
        newHull.angle = this.wrappedAngle;
        newHull.pos = this.pos;
        this.activeHull = newHull;
    }

    get bbox() {
        return this.activeHull.bbox;
    }
}

export const HitboxHullComponent = new Component<Hull>('HitboxHullComponent');
export const HurtboxHullComponent = new Component<Hull>('HurtboxHullComponent');

function signedArea(points: readonly SAT.Vector[]): number {
    let twiceArea = 0;
    for (let index = 0; index < points.length; index++) {
        const point = points[index];
        const next = points[(index + 1) % points.length];
        twiceArea += point.x * next.y - next.x * point.y;
    }
    return twiceArea / 2;
}

/**
 * Sprite-sheet hulls use image-independent y-up coordinates. SAT.js operates
 * in the screen's y-down coordinates and expects positive-winding polygons
 * for polygon/circle tests. The old hull.js parser and the Rust parser emit
 * opposite windings, so normalize after flipping y instead of blindly
 * reversing every resource.
 */
export function satPolygonFromConvexHull(
    convexHull: readonly [number, number][],
): SAT.Polygon {
    let points = convexHull.map(([x, y]) => new SAT.Vector(x, -y));
    if (signedArea(points) < 0) {
        points = points.reverse();
    }
    return new SAT.Polygon(new SAT.Vector(), points);
}

export async function hullFromAnimation(animation: Animation, gameData: GameDataInterface) {
    const spriteSheet = await gameData.data.SpriteSheet
        .get(animation.images.baseImage.id);

    const hulls = spriteSheet.hulls.map(hull =>
        hull.map(satPolygonFromConvexHull))
        .map(convexPolys => new CompositeHull(convexPolys));

    return new MultiFrameHull(hulls);
}

const HitboxHullProvider = ProvideAsync({
    name: "HitboxProvider",
    provided: HitboxHullComponent,
    args: [AnimationComponent, GameDataResource, CollisionVulnerabilityComponent] as const,
    factory: hullFromAnimation,
});

enum RBushEntryType {
    hurtbox,
    hitbox,
}

type RBushEntry = BBox & {
    uuid: string,
    hull: Hull,
    displacement: { x: number, y: number },
    position: { x: number, y: number },
    projectile: boolean,
} & ({
    type: RBushEntryType.hurtbox,
    hitter: CollisionHitter,
} | {
    type: RBushEntryType.hitbox,
    vulnerability: CollisionVulnerability,
});

export const RBushResource = new Resource<RBush<RBushEntry>>("RBushResource");
const movementStarts = new WeakMap<RBush<RBushEntry>, Map<string, { x: number, y: number }>>();

export const CaptureCollisionMovementSystem = new System({
    name: 'CaptureCollisionMovementSystem',
    args: [RBushResource, TimeResource, new Query([
        UUID, MovementStateComponent, Optional(RemoteMovementPresentationComponent),
    ] as const), SingletonComponent] as const,
    after: [TimeSystem],
    before: [MovementSystem],
    step(tree, time, movements) {
        const starts = new Map<string, { x: number, y: number }>();
        // Never join separate ticks, pauses, or observer snapshot corrections.
        if (Number.isFinite(time.delta_s) && time.delta_s > 0) {
            for (const [id, movement, presentation] of movements) {
                if (!presentation) starts.set(id, {
                    x: movement.position.x, y: movement.position.y,
                });
            }
        }
        movementStarts.set(tree, starts);
    },
});

export function getBoundingBox(shapes: Shape[]): BBox {
    return shapes.map(
        p => (p as unknown as { getAABBAsBox(): SAT.Box }).getAABBAsBox())
        .map(box => ({
            minX: box.pos.x,
            minY: box.pos.y,
            maxX: box.pos.x + box.w,
            maxY: box.pos.y + box.h,
        }))
        .reduce((a, b) => ({
            minX: Math.min(a.minX, b.minX),
            minY: Math.min(a.minY, b.minY),
            maxX: Math.max(a.maxX, b.maxX),
            maxY: Math.max(a.maxY, b.maxY),
        }));
}

function aHitsB(a: CollisionHitter, b: CollisionVulnerability) {
    for (const hitType of a.hitTypes) {
        if (b.vulnerableTo.has(hitType)) {
            return true;
        }
    }
    return false;
}

function translateAabb(bbox: BBox, { x, y }: { x: number, y: number }): BBox {
    return {
        minX: bbox.minX + x,
        minY: bbox.minY + y,
        maxX: bbox.maxX + x,
        maxY: bbox.maxY + y,
    };
}

function rotateAabb(bbox: BBox, angle: number | Angle): BBox {
    const points = [
        new Vector(bbox.minX, bbox.minY).rotate(angle),
        new Vector(bbox.minX, bbox.maxY).rotate(angle),
        new Vector(bbox.maxX, bbox.minY).rotate(angle),
        new Vector(bbox.maxX, bbox.maxY).rotate(angle),
    ];

    const x = points.map(v => v.x);
    const y = points.map(v => v.y);

    return {
        maxX: Math.max(...x),
        maxY: Math.max(...y),
        minX: Math.min(...x),
        minY: Math.min(...y),
    };
}

export const UpdateHitboxHullSystem = new System({
    name: "UpdateHitboxHullSystem",
    args: [MovementStateComponent, HitboxHullComponent, Optional(AnimationComponent)] as const,
    step(movement, hull, animation) {
        let angle = movement.rotation.angle;
        if (hull instanceof MultiFrameHull) {
            let frame = 0;
            if (animation) {
                ({ frame, angle } = getFrameFromMovement(animation, movement));
            }
            hull.frame = frame;
        }

        hull.pos.x = movement.position.x;
        hull.pos.y = movement.position.y;
        hull.angle = angle;
    },
    after: [MovementSystem, RemoteMovementPresentationSystem],
});

export const UpdateHurtboxHullSystem = new System({
    name: "UpdateHurtboxHullSystem",
    args: [MovementStateComponent, HurtboxHullComponent, Optional(AnimationComponent)] as const,
    step: UpdateHitboxHullSystem.step,
    after: [MovementSystem, RemoteMovementPresentationSystem],
});

// Local event extension; beam and other discrete events keep their existing shape.
export interface SweptCollisionContact {
    other: string;
    initiator: boolean;
    impactPosition?: { x: number, y: number };
}

export const CollisionSystem = new System({
    name: "CollisionSystem",
    after: [UpdateHitboxHullSystem, UpdateHurtboxHullSystem],
    args: [RBushResource,
        new Query([HitboxHullComponent, UUID, CollisionVulnerabilityComponent, Optional(MovementStateComponent)] as const),
        new Query([HurtboxHullComponent, UUID, CollisionHitterComponent, Optional(ProjectileComponent), Optional(MovementStateComponent)] as const),
        Emit, SingletonComponent] as const,
    step(rbush, hitboxColliders, hurtboxColliders, emit) {
        const starts = movementStarts.get(rbush);
        movementStarts.delete(rbush);
        // Hulls and interaction components can be mutable or revocable drafts.
        // Keep tree entries only for this invocation, never across ticks.
        rbush.clear();
        const currentEntries: RBushEntry[] = [];
        function updateEntry(type: RBushEntryType, hull: Hull, uuid: string,
            interaction: CollisionHitter | CollisionVulnerability,
            movement: MovementState | undefined, projectile = false) {
            const start = starts?.get(uuid);
            // Translate endpoint geometry by actual entity travel, not by the
            // hull origin: an offset hull is not additional movement.
            let displacement = start && movement
                ? { x: movement.position.x - start.x, y: movement.position.y - start.y }
                : { x: 0, y: 0 };
            if (!Number.isFinite(displacement.x) || !Number.isFinite(displacement.y)
                || Math.abs(displacement.x) >= BOUNDARY
                || Math.abs(displacement.y) >= BOUNDARY) {
                displacement = { x: 0, y: 0 };
            }
            const bbox = hull.bbox;
            const entry = {
                ...(type === RBushEntryType.hitbox || projectile ? {
                    minX: Math.min(bbox.minX, bbox.minX - displacement.x),
                    minY: Math.min(bbox.minY, bbox.minY - displacement.y),
                    maxX: Math.max(bbox.maxX, bbox.maxX - displacement.x),
                    maxY: Math.max(bbox.maxY, bbox.maxY - displacement.y),
                } : bbox),
                uuid, hull, type, displacement, projectile,
                position: {
                    x: movement?.position.x ?? hull.pos.x,
                    y: movement?.position.y ?? hull.pos.y,
                },
                ...('vulnerableTo' in interaction
                    ? { vulnerability: interaction } : { hitter: interaction }),
            } as RBushEntry;
            currentEntries.push(entry);
        }
        for (const [hull, uuid, interaction, movement] of hitboxColliders) {
            updateEntry(RBushEntryType.hitbox, hull, uuid, interaction, movement);
        }
        for (const [hull, uuid, interaction, projectile, movement] of hurtboxColliders) {
            updateEntry(RBushEntryType.hurtbox, hull, uuid, interaction, movement,
                projectile !== undefined);
        }

        // Check for collisions
        const alreadyCollided = new Map<string, Set<string>>();
        function hasAlreadyCollided(a: string, b: string) {
            return alreadyCollided.get(a)?.has(b) || alreadyCollided.get(b)?.has(a);
        }
        function recordCollision(a: string, b: string) {
            let collisionsWith = alreadyCollided.get(a);
            if (!collisionsWith) {
                collisionsWith = new Set();
                alreadyCollided.set(a, collisionsWith);
            }
            collisionsWith.add(b);
        }

        const contacts: { entry: RBushEntry, other: RBushEntry, time: number }[] = [];
        try {
            // Only hitboxes are searched for; indexing hurtboxes wastes tree
            // work, particularly with many projectiles in flight.
            rbush.load(currentEntries.filter(entry => entry.type === RBushEntryType.hitbox));
            for (const entry of currentEntries) {
                // Hurtboxes (projectiles, beams, blasts) initiate collisions against hitboxes (ships, asteroids).
                // Hitboxes do not search the tree, halving broadphase query overhead.
                if (entry.type !== RBushEntryType.hurtbox) {
                    continue;
                }

                const maybeCollisions = rbush.search(entry);

                for (const other of maybeCollisions) {
                    if (other.type !== RBushEntryType.hitbox || other.uuid === entry.uuid) {
                        continue;
                    }
                    const hitter = entry.hitter;
                    const vulnerability = (other as { vulnerability: CollisionVulnerability }).vulnerability;

                    if (!aHitsB(hitter, vulnerability)) {
                        continue;
                    }
                    const time = entry.projectile
                        ? sweptHullTime(entry.hull.shapes, other.hull.shapes,
                            entry.displacement, other.displacement)
                        : entry.hull.collides(other.hull) ? 1 : undefined;
                    if (time !== undefined) contacts.push({ entry, other, time });
                }
            }
            // Emit all candidates: ownership/proximity checks may reject the first.
            // Queued UUID events for a consumed projectile are skipped by the ECS.
            contacts.sort((a, b) => a.time - b.time
                || a.entry.uuid.localeCompare(b.entry.uuid)
                || a.other.uuid.localeCompare(b.other.uuid));
            for (const { entry, other, time } of contacts) {
                if (hasAlreadyCollided(entry.uuid, other.uuid)) continue;
                recordCollision(entry.uuid, other.uuid);
                const contact: SweptCollisionContact = { other: other.uuid, initiator: true };
                if (entry.projectile && time < 1
                    && (entry.displacement.x !== 0 || entry.displacement.y !== 0)) {
                    contact.impactPosition = {
                        x: entry.position.x - entry.displacement.x * (1 - time),
                        y: entry.position.y - entry.displacement.y * (1 - time),
                    };
                }
                emit(CollisionEvent, contact, [entry.uuid]);
                emit(CollisionEvent, { other: entry.uuid, initiator: false }, [other.uuid]);
            }
        } finally {
            rbush.clear();
        }
    }
});

const LogCollisionSystem = new System({
    name: "LogCollisionSystem",
    events: [CollisionEvent],
    args: [CollisionEvent, UUID] as const,
    step({ other }, uuid) {
        console.log(`${uuid} hit by ${other}`);
    }
});

export const CollisionsPlugin: Plugin = {
    name: 'CollisionsPlugin',
    build(world) {
        void initNovaWasm().catch(() => {
            // CollisionSystem retains the SAT.js fallback if WASM is unavailable.
        });
        //world.addComponent(HullComponent);
        world.resources.set(RBushResource, new RBush());

        world.addSystem(HitboxHullProvider);

        world.addSystem(CaptureCollisionMovementSystem);
        world.addSystem(UpdateHitboxHullSystem);
        world.addSystem(UpdateHurtboxHullSystem);
        world.addSystem(CollisionSystem);
        //world.addSystem(LogCollisionSystem);
    }
};
