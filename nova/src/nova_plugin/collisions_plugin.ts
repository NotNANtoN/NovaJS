import { Animation } from "novadatainterface/Animation";
import { GameDataInterface } from "novadatainterface/GameDataInterface";
import { Emit, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Angle } from "nova_ecs/datatypes/angle";
import { Vector } from "nova_ecs/datatypes/vector";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent, MovementSystem } from "nova_ecs/plugins/movement_plugin";
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
        polygons,
        vertices: new Float32Array(vertices),
        offsets: new Uint32Array(offsets),
    };
    polygonBatchGeometry.set(hull, geometry);
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

export async function hullFromAnimation(animation: Animation, gameData: GameDataInterface) {
    const spriteSheet = await gameData.data.SpriteSheet
        .get(animation.images.baseImage.id);

    const hulls = spriteSheet.hulls.map(hull =>
        hull.map(convexHull => new SAT.Polygon(new SAT.Vector(),
            convexHull.slice().reverse().map(([x, y]) => new SAT.Vector(x, -y)))))
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
} & ({
    type: RBushEntryType.hurtbox,
    hitter: CollisionHitter,
} | {
    type: RBushEntryType.hitbox,
    vulnerability: CollisionVulnerability,
});

export const RBushResource = new Resource<RBush<RBushEntry>>("RBushResource");
const rbushEntriesByTree = new WeakMap<
    RBush<RBushEntry>,
    Map<string, Map<RBushEntryType, RBushEntry>>
>();
const RBUSH_EPSILON = 0.0001;

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
    after: [MovementSystem],
});

export const UpdateHurtboxHullSystem = new System({
    name: "UpdateHurtboxHullSystem",
    args: [MovementStateComponent, HurtboxHullComponent, Optional(AnimationComponent)] as const,
    step: UpdateHitboxHullSystem.step,
    after: [MovementSystem],
});

export const CollisionSystem = new System({
    name: "CollisionSystem",
    after: [UpdateHitboxHullSystem],
    args: [RBushResource,
        new Query([HitboxHullComponent, UUID, CollisionVulnerabilityComponent] as const),
        new Query([HurtboxHullComponent, UUID, CollisionHitterComponent] as const),
        Emit, SingletonComponent] as const,
    step(rbush, hitboxColliders, hurtboxColliders, emit) {
        let entriesByEntity = rbushEntriesByTree.get(rbush);
        if (!entriesByEntity) {
            entriesByEntity = new Map();
            rbushEntriesByTree.set(rbush, entriesByEntity);
        }

        function makeRbushEntry(type: RBushEntryType, [hull, uuid, interaction]:
            readonly [Hull, string, CollisionHitter | CollisionVulnerability]): RBushEntry {
            const entry = {
                ...hull.bbox,
                uuid,
                hull,
                type,
            } as RBushEntry;
            if ('vulnerableTo' in interaction) {
                (entry as { vulnerability: CollisionVulnerability })
                    .vulnerability = interaction;
            } else {
                (entry as { hitter: CollisionHitter }).hitter = interaction;
            }
            return entry;
        }

        const currentEntries = new Set<RBushEntry>();
        function updateEntry(type: RBushEntryType, data:
            readonly [Hull, string, CollisionHitter | CollisionVulnerability]) {
            const [hull, uuid, interaction] = data;
            let entriesForEntity = entriesByEntity!.get(uuid);
            if (!entriesForEntity) {
                entriesForEntity = new Map();
                entriesByEntity!.set(uuid, entriesForEntity);
            }

            let entry = entriesForEntity.get(type);
            if (!entry) {
                entry = makeRbushEntry(type, data);
                entriesForEntity.set(type, entry);
                rbush.insert(entry);
            } else {
                const bbox = hull.bbox;
                const changed = [
                    Math.abs(entry.minX - bbox.minX),
                    Math.abs(entry.minY - bbox.minY),
                    Math.abs(entry.maxX - bbox.maxX),
                    Math.abs(entry.maxY - bbox.maxY),
                ].some(delta => delta > RBUSH_EPSILON);
                if (changed) {
                    rbush.remove(entry);
                    entry.minX = bbox.minX;
                    entry.minY = bbox.minY;
                    entry.maxX = bbox.maxX;
                    entry.maxY = bbox.maxY;
                    rbush.insert(entry);
                }
                entry.hull = hull;
                if ('vulnerableTo' in interaction) {
                    (entry as { vulnerability: CollisionVulnerability })
                        .vulnerability = interaction;
                } else {
                    (entry as { hitter: CollisionHitter }).hitter = interaction;
                }
            }
            currentEntries.add(entry);
        }

        for (const data of hitboxColliders) {
            updateEntry(RBushEntryType.hitbox, data);
        }
        for (const data of hurtboxColliders) {
            updateEntry(RBushEntryType.hurtbox, data);
        }

        for (const [uuid, entriesForEntity] of entriesByEntity) {
            for (const [type, entry] of entriesForEntity) {
                if (!currentEntries.has(entry)) {
                    rbush.remove(entry);
                    entriesForEntity.delete(type);
                }
            }
            if (entriesForEntity.size === 0) {
                entriesByEntity.delete(uuid);
            }
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

        for (const entry of currentEntries) {
            const maybeCollisions = rbush.search(entry)
                .filter(found => found !== entry);

            for (const other of maybeCollisions) {
                if (entry.type === other.type) {
                    continue; // Hurtboxes can only hit hitboxes.
                }
                // The initiator of a collision must have its hurtbox overlap the other
                // collier's hitbox. If the inverse is allowed, then a missile's prox radius
                // overlapping a point defense weapon can be considered a collision initiated
                // by the point defense weapon, meaning the point defense weapon can hit the
                // missile by hitting its prox radius (bad).
                let entryInitiates: boolean;
                let hitter: CollisionHitter;
                let vulnerability: CollisionVulnerability;
                if (entry.type === RBushEntryType.hurtbox) {
                    entryInitiates = true;
                    hitter = entry.hitter;
                    vulnerability = (other as
                        { vulnerability: CollisionVulnerability }).vulnerability;
                } else {
                    entryInitiates = false;
                    vulnerability = entry.vulnerability;
                    hitter = (other as { hitter: CollisionHitter }).hitter;
                }
                const canCollide = aHitsB(hitter, vulnerability);
                if (canCollide &&
                    !hasAlreadyCollided(entry.uuid, other.uuid) &&
                    entry.hull.collides(other.hull)) {
                    recordCollision(entry.uuid, other.uuid);
                    emit(CollisionEvent, {
                        other: other.uuid,
                        initiator: entryInitiates,
                    }, [entry.uuid]);
                    emit(CollisionEvent, {
                        other: entry.uuid,
                        initiator: !entryInitiates,
                    }, [other.uuid]);
                }
            }
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

        world.addSystem(UpdateHitboxHullSystem);
        world.addSystem(UpdateHurtboxHullSystem);
        world.addSystem(CollisionSystem);
        //world.addSystem(LogCollisionSystem);
    }
};
