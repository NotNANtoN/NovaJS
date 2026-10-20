import * as SAT from 'sat';
import {
    init as initNovaWasm,
    isInitialized as isNovaWasmInitialized,
    sweptCirclePolygonTime as wasmSweptCirclePolygonTime,
    sweptPolygonPolygonTime as wasmSweptPolygonPolygonTime,
} from '../../../nova_wasm';

let wasmInitStarted = false;
function ensureWasmReady(): boolean {
    if (isNovaWasmInitialized()) {
        return true;
    }
    if (!wasmInitStarted) {
        wasmInitStarted = true;
        void initNovaWasm().catch(() => {});
    }
    return false;
}

const cachedPolygonVertices = new WeakMap<
    SAT.Polygon,
    { angle: number; len: number; x0: number; y0: number; flat: Float32Array }
>();

function flatPolygonVertices(shape: SAT.Polygon): Float32Array {
    const calc = shape.calcPoints;
    const len = calc.length;
    const x0 = len > 0 ? calc[0].x : 0;
    const y0 = len > 0 ? calc[0].y : 0;
    const cached = cachedPolygonVertices.get(shape);
    if (
        cached
        && cached.angle === shape.angle
        && cached.len === len
        && cached.x0 === x0
        && cached.y0 === y0
    ) {
        return cached.flat;
    }
    const flat = cached && cached.len === len
        ? cached.flat
        : new Float32Array(len * 2);
    for (let i = 0; i < len; i++) {
        flat[i * 2] = calc[i].x;
        flat[i * 2 + 1] = calc[i].y;
    }
    cachedPolygonVertices.set(shape, { angle: shape.angle, len, x0, y0, flat });
    return flat;
}

interface Point { x: number; y: number }
type Shape = SAT.Polygon | SAT.Circle;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const EPSILON = 1e-9;

function circleTime(p: Point, velocity: Point, radius: number): number | undefined {
    const c = dot(p, p) - radius * radius;
    if (c <= EPSILON) return 0;
    const a = dot(velocity, velocity);
    const b = dot(p, velocity);
    if (a === 0 || b >= 0) return undefined;
    const discriminant = b * b - a * c;
    if (discriminant < -EPSILON) return undefined;
    // Stable smaller root, including tangencies.
    const t = c / (-b + Math.sqrt(Math.max(0, discriminant)));
    return t >= 0 && t <= 1 ? t : undefined;
}

function points(shape: SAT.Polygon, offset: Point): Point[] {
    return shape.calcPoints.map(p => ({
        x: p.x + shape.pos.x + offset.x,
        y: p.y + shape.pos.y + offset.y,
    }));
}

function polygonTime(a: Point[], b: Point[], velocity: Point): number | undefined {
    let enter = 0;
    let exit = 1;
    for (const polygon of [a, b]) {
        for (let i = 0; i < polygon.length; i++) {
            const edge = sub(polygon[(i + 1) % polygon.length], polygon[i]);
            const axis = { x: -edge.y, y: edge.x };
            if (dot(axis, axis) === 0) continue;
            let minA = Infinity, maxA = -Infinity;
            let minB = Infinity, maxB = -Infinity;
            for (const point of a) {
                const projection = dot(point, axis);
                minA = Math.min(minA, projection);
                maxA = Math.max(maxA, projection);
            }
            for (const point of b) {
                const projection = dot(point, axis);
                minB = Math.min(minB, projection);
                maxB = Math.max(maxB, projection);
            }
            const low = minB - maxA;
            const high = maxB - minA;
            const speed = dot(velocity, axis);
            if (speed === 0) {
                if (low > EPSILON || high < -EPSILON) return undefined;
            } else {
                enter = Math.max(enter, Math.min(low / speed, high / speed));
                exit = Math.min(exit, Math.max(low / speed, high / speed));
                if (enter > exit + EPSILON) return undefined;
            }
        }
    }
    return enter <= 1 && exit >= 0 ? enter : undefined;
}

function circlePolygonTime(center: Point, radius: number, polygon: Point[],
    velocity: Point): number | undefined {
    // The rounded polygon is the polygon interior plus its edge capsules.
    const candidates: number[] = [];
    let positive = false;
    let negative = false;
    for (let i = 0; i < polygon.length; i++) {
        const start = polygon[i];
        const edge = sub(polygon[(i + 1) % polygon.length], start);
        const relative = sub(center, start);
        const cross = edge.x * relative.y - edge.y * relative.x;
        positive ||= cross > EPSILON;
        negative ||= cross < -EPSILON;
        const vertexTime = circleTime(relative, velocity, radius);
        if (vertexTime !== undefined) candidates.push(vertexTime);
        const length = Math.hypot(edge.x, edge.y);
        if (length === 0) continue;
        const tangent = { x: edge.x / length, y: edge.y / length };
        const normal = { x: -tangent.y, y: tangent.x };
        const distance = dot(relative, normal);
        const speed = dot(velocity, normal);
        const along = dot(relative, tangent);
        if (Math.abs(distance) <= radius && along >= 0 && along <= length) return 0;
        if (speed === 0) continue;
        for (const side of [-radius, radius]) {
            const t = (side - distance) / speed;
            const projection = along + t * dot(velocity, tangent);
            if (t >= 0 && t <= 1 && projection >= 0 && projection <= length) candidates.push(t);
        }
    }
    if (polygon.length >= 3 && !(positive && negative)) return 0;
    return candidates.length ? Math.min(...candidates) : undefined;
}

/** Earliest translational contact in [0, 1]. Shapes are endpoint geometry;
 * displacements move them from their tick starts to those endpoints. No shape
 * is mutated or retained. Rotation/frame changes are deliberately not swept.
 *
 * `shiftA` translates A's whole sweep. Lag compensation uses it to test a
 * projectile against where a target was, rather than where it is now.
 */
export function sweptHullTime(a: readonly Shape[], b: readonly Shape[],
    da: Point, db: Point, shiftA: Point = { x: 0, y: 0 }): number | undefined {
    const vx = da.x - db.x;
    const vy = da.y - db.y;
    const offsetAx = shiftA.x - da.x;
    const offsetAy = shiftA.y - da.y;
    const offsetBx = -db.x;
    const offsetBy = -db.y;

    if (ensureWasmReady()) {
        let first: number | undefined;
        for (const sa of a) {
            for (const sb of b) {
                let t: number | undefined;
                if (sa instanceof SAT.Circle) {
                    const cx = sa.pos.x + offsetAx;
                    const cy = sa.pos.y + offsetAy;
                    if (sb instanceof SAT.Circle) {
                        const bx = sb.pos.x + offsetBx;
                        const by = sb.pos.y + offsetBy;
                        t = circleTime(
                            { x: cx - bx, y: cy - by },
                            { x: vx, y: vy },
                            sa.r + sb.r,
                        );
                    } else {
                        const raw = wasmSweptCirclePolygonTime(
                            cx,
                            cy,
                            sa.r,
                            flatPolygonVertices(sb),
                            sb.pos.x + offsetBx,
                            sb.pos.y + offsetBy,
                            vx,
                            vy,
                        );
                        t = raw >= 0 ? raw : undefined;
                    }
                } else if (sb instanceof SAT.Circle) {
                    const cx = sb.pos.x + offsetBx;
                    const cy = sb.pos.y + offsetBy;
                    const raw = wasmSweptCirclePolygonTime(
                        cx,
                        cy,
                        sb.r,
                        flatPolygonVertices(sa),
                        sa.pos.x + offsetAx,
                        sa.pos.y + offsetAy,
                        -vx,
                        -vy,
                    );
                    t = raw >= 0 ? raw : undefined;
                } else {
                    const raw = wasmSweptPolygonPolygonTime(
                        flatPolygonVertices(sa),
                        sa.pos.x + offsetAx,
                        sa.pos.y + offsetAy,
                        flatPolygonVertices(sb),
                        sb.pos.x + offsetBx,
                        sb.pos.y + offsetBy,
                        vx,
                        vy,
                    );
                    t = raw >= 0 ? raw : undefined;
                }
                if (t === 0) return 0;
                if (t !== undefined && (first === undefined || t < first)) first = t;
            }
        }
        return first;
    }

    const velocity = { x: vx, y: vy };
    const offsetA = { x: offsetAx, y: offsetAy };
    const offsetB = { x: offsetBx, y: offsetBy };
    // Prepare each polygon once per hull pair, not once for every convex
    // shape pair. These arrays are invocation-local, never a draft/hull cache.
    const preparedA = a.map(shape => shape instanceof SAT.Polygon ? points(shape, offsetA) : shape);
    const preparedB = b.map(shape => shape instanceof SAT.Polygon ? points(shape, offsetB) : shape);
    let first: number | undefined;
    for (const sa of preparedA) for (const sb of preparedB) {
        let t: number | undefined;
        if (sa instanceof SAT.Circle) {
            t = sb instanceof SAT.Circle
                ? circleTime(sub(sub(sa.pos, sub(da, shiftA)), sub(sb.pos, db)), velocity, sa.r + sb.r)
                : circlePolygonTime(sub(sa.pos, sub(da, shiftA)), sa.r, sb, velocity);
        } else if (sb instanceof SAT.Circle) {
            t = circlePolygonTime(sub(sb.pos, db), sb.r, sa,
                { x: -velocity.x, y: -velocity.y });
        } else {
            t = polygonTime(sa, sb, velocity);
        }
        if (t === 0) return 0;
        if (t !== undefined && (first === undefined || t < first)) first = t;
    }
    return first;
}
