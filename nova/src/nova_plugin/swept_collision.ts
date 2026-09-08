import * as SAT from 'sat';

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
 */
export function sweptHullTime(a: readonly Shape[], b: readonly Shape[],
    da: Point, db: Point): number | undefined {
    const velocity = sub(da, db);
    const offsetA = { x: -da.x, y: -da.y };
    const offsetB = { x: -db.x, y: -db.y };
    // Prepare each polygon once per hull pair, not once for every convex
    // shape pair. These arrays are invocation-local, never a draft/hull cache.
    const preparedA = a.map(shape => shape instanceof SAT.Polygon ? points(shape, offsetA) : shape);
    const preparedB = b.map(shape => shape instanceof SAT.Polygon ? points(shape, offsetB) : shape);
    let first: number | undefined;
    for (const sa of preparedA) for (const sb of preparedB) {
        let t: number | undefined;
        if (sa instanceof SAT.Circle) {
            t = sb instanceof SAT.Circle
                ? circleTime(sub(sub(sa.pos, da), sub(sb.pos, db)), velocity, sa.r + sb.r)
                : circlePolygonTime(sub(sa.pos, da), sa.r, sb, velocity);
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
