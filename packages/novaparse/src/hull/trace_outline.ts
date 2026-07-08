/**
 * Extracts a sprite's outline polygon from its opacity mask. The outline
 * feeds approximate convex decomposition (convex_decomposition.ts), so it
 * must be a pure, deterministic function of the mask: pixels are visited
 * in row-major order and every choice is order-based.
 */

import { Point } from "./convex_decomposition.js";

export interface Mask {
    width: number;
    height: number;
    /** Whether the pixel at (x, y) is solid. Out of range is empty. */
    isFilled(x: number, y: number): boolean;
}

/**
 * Traces the boundary of the largest solid region of the mask as a closed
 * polygon of pixel-corner points, in image coordinates (y down). Boundary
 * edges are walked clockwise around solid pixels, so separate regions and
 * holes form separate loops; the loop enclosing the most area is the
 * outer boundary of the largest region. Returns undefined for an empty
 * mask.
 */
export function traceOutline(mask: Mask): Point[] | undefined {
    const { width, height, isFilled } = mask;
    // Directed boundary edges between pixel corners, keyed by their start
    // corner. Corners are encoded as y * (width + 1) + x. A corner has at
    // most two outgoing edges (only where two solid pixels meet
    // diagonally), so a pair of maps suffices.
    const cornersPerRow = width + 1;
    const edges = new Map<number, number>();
    const extraEdges = new Map<number, number>();
    function addEdge(from: number, to: number) {
        if (edges.has(from)) {
            extraEdges.set(from, to);
        } else {
            edges.set(from, to);
        }
    }

    const startCorners: number[] = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!isFilled(x, y)) {
                continue;
            }
            const topLeft = y * cornersPerRow + x;
            const topRight = topLeft + 1;
            const bottomLeft = topLeft + cornersPerRow;
            const bottomRight = bottomLeft + 1;
            // Wind clockwise on screen (y down) around each solid pixel.
            if (!isFilled(x, y - 1)) {
                addEdge(topLeft, topRight);
                startCorners.push(topLeft);
            }
            if (!isFilled(x + 1, y)) {
                addEdge(topRight, bottomRight);
            }
            if (!isFilled(x, y + 1)) {
                addEdge(bottomRight, bottomLeft);
            }
            if (!isFilled(x - 1, y)) {
                addEdge(bottomLeft, topLeft);
            }
        }
    }

    let best: Point[] | undefined;
    let bestArea = 0;
    for (const start of startCorners) {
        if (!edges.has(start) && !extraEdges.has(start)) {
            continue; // Already consumed by an earlier loop.
        }
        const loop = followLoop(start, cornersPerRow, edges, extraEdges);
        const area = Math.abs(loopArea(loop));
        if (area > bestArea) {
            bestArea = area;
            best = loop;
        }
    }
    return best;
}

function followLoop(start: number, cornersPerRow: number,
    edges: Map<number, number>, extraEdges: Map<number, number>): Point[] {
    const loop: Point[] = [];
    let previousDirection: Point | undefined;
    let corner = start;
    do {
        const point: Point = [corner % cornersPerRow,
        Math.floor(corner / cornersPerRow)];
        // Where two solid pixels touch only diagonally, four boundary
        // edges meet at one corner. Turning right (relative to the
        // incoming edge) pinches the boundary there instead of crossing
        // it, keeping every loop simple.
        let next = edges.get(corner);
        const extra = extraEdges.get(corner);
        if (next !== undefined && extra !== undefined && previousDirection) {
            // Right turn on screen (y down): (dx, dy) -> (-dy, dx).
            const rightX = point[0] - previousDirection[1];
            const rightY = point[1] + previousDirection[0];
            if (extra % cornersPerRow === rightX &&
                Math.floor(extra / cornersPerRow) === rightY) {
                next = extra;
            }
        }
        if (next === undefined) {
            next = extra;
            extraEdges.delete(corner);
        } else if (next === extra) {
            extraEdges.delete(corner);
        } else {
            edges.delete(corner);
        }
        if (next === undefined) {
            throw new Error('Boundary edge loop did not close');
        }
        const nextPoint: Point = [next % cornersPerRow,
        Math.floor(next / cornersPerRow)];
        const direction: Point = [nextPoint[0] - point[0],
        nextPoint[1] - point[1]];
        // Merge runs of unit edges going the same way as they are walked.
        if (previousDirection && previousDirection[0] === direction[0] &&
            previousDirection[1] === direction[1]) {
            loop.pop();
        }
        loop.push(nextPoint);
        previousDirection = direction;
        corner = next;
    } while (corner !== start);
    return loop;
}

function loopArea(loop: Point[]): number {
    let area = 0;
    for (let i = 0; i < loop.length; i++) {
        const [x0, y0] = loop[i];
        const [x1, y1] = loop[(i + 1) % loop.length];
        area += x0 * y1 - x1 * y0;
    }
    return area / 2;
}

/**
 * Ramer-Douglas-Peucker simplification of a closed polygon: vertices
 * farther than `epsilon` from the chord of their chain are kept. The
 * polygon is anchored at its first vertex and the vertex farthest from
 * it, so the result is deterministic.
 */
export function simplifyPolygon(polygon: Point[], epsilon: number): Point[] {
    if (polygon.length <= 3) {
        return polygon.slice();
    }
    let farthest = 1;
    let farthestDistance = 0;
    for (let i = 1; i < polygon.length; i++) {
        const d = Math.hypot(polygon[i][0] - polygon[0][0],
            polygon[i][1] - polygon[0][1]);
        if (d > farthestDistance) {
            farthestDistance = d;
            farthest = i;
        }
    }
    return [
        ...simplifyChain(polygon.slice(0, farthest + 1), epsilon),
        ...simplifyChain([...polygon.slice(farthest), polygon[0]], epsilon)
            .slice(1, -1),
    ];
}

function simplifyChain(chain: Point[], epsilon: number): Point[] {
    if (chain.length <= 2) {
        return chain.slice();
    }
    const [startX, startY] = chain[0];
    const [endX, endY] = chain[chain.length - 1];
    const chordX = endX - startX;
    const chordY = endY - startY;
    const chordLength = Math.hypot(chordX, chordY);
    let farthest = 0;
    let farthestDistance = 0;
    for (let i = 1; i < chain.length - 1; i++) {
        const [x, y] = chain[i];
        const d = chordLength === 0
            ? Math.hypot(x - startX, y - startY)
            : Math.abs(chordX * (y - startY) - chordY * (x - startX))
            / chordLength;
        if (d > farthestDistance) {
            farthestDistance = d;
            farthest = i;
        }
    }
    if (farthestDistance <= epsilon) {
        return [chain[0], chain[chain.length - 1]];
    }
    return [
        ...simplifyChain(chain.slice(0, farthest + 1), epsilon),
        ...simplifyChain(chain.slice(farthest), epsilon).slice(1),
    ];
}
