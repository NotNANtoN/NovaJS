/**
 * Where a ship is when you first see it.
 *
 * Ambient traffic used to be dropped into a 600-unit box at the system origin,
 * so ships blinked into existence on top of one another in the middle of
 * nowhere. Nothing in EV Nova's data describes spawn placement — it is a
 * presentation problem, not a rule — but the data does say where a ship could
 * plausibly have come from: a sÿst lists its hyperspace `links` and the galaxy
 * position of every system, and it lists the stellars a ship can launch from.
 *
 * So a ship either arrives from hyperspace, appearing far out on the bearing of
 * the system it came from and heading inward, or it lifts off from a stellar.
 */

export type ArrivalRandom = () => number;

/** How far out a ship drops in from hyperspace. */
export const HYPERSPACE_ENTRY_RADIUS = 6_000;

/** How far off a stellar a launching ship appears. */
export const STELLAR_LAUNCH_OFFSET = 700;

/**
 * Fraction of ambient traffic that lifts off from a stellar rather than
 * arriving from hyperspace. Traffic reads best as mostly local coming and
 * going, with arrivals from outside as the minority.
 */
export const STELLAR_LAUNCH_SHARE = 0.5;

export interface ArrivalPlacement {
    position: [number, number];
    /** Nova headings: 0 is up and angles run clockwise. */
    rotation: number;
    origin: 'hyperspace' | 'stellar';
}

export interface ArrivalSystem {
    position: readonly [number, number];
    links: readonly string[];
    planets: readonly string[];
}

function sample(random: ArrivalRandom): number {
    const value = random();
    return Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0;
}

function pick<T>(items: readonly T[], random: ArrivalRandom): T | undefined {
    if (items.length === 0) {
        return undefined;
    }
    return items[Math.floor(sample(random) * items.length)];
}

/** Nova measures headings from straight up, turning clockwise. */
export function headingTowards(
    from: readonly [number, number],
    to: readonly [number, number],
): number {
    return Math.atan2(to[0] - from[0], -(to[1] - from[1]));
}

/**
 * Drop a ship in at the edge of the system, on the side facing whichever
 * neighbour it travelled from, pointed inward as though it had just come out
 * of hyperspace.
 */
export function hyperspaceEntry(
    system: ArrivalSystem,
    neighbourPositions: ReadonlyMap<string, readonly [number, number]>,
    random: ArrivalRandom,
    radius = HYPERSPACE_ENTRY_RADIUS,
): ArrivalPlacement | undefined {
    const known = system.links.filter(link => neighbourPositions.has(link));
    const from = pick(known, random);
    const neighbour = from === undefined
        ? undefined
        : neighbourPositions.get(from);
    // A system with no mapped neighbours still gets an edge arrival, just on
    // an arbitrary bearing rather than a meaningful one.
    const bearing = neighbour
        ? headingTowards(system.position, neighbour)
        : sample(random) * Math.PI * 2;
    const outward = { x: Math.sin(bearing), y: -Math.cos(bearing) };
    return {
        position: [outward.x * radius, outward.y * radius],
        rotation: bearing + Math.PI,
        origin: 'hyperspace',
    };
}

/** Put a ship just off a stellar, heading away from it, as if it just left. */
export function stellarLaunch(
    stellarPosition: readonly [number, number],
    random: ArrivalRandom,
    offset = STELLAR_LAUNCH_OFFSET,
): ArrivalPlacement {
    const bearing = sample(random) * Math.PI * 2;
    const outward = { x: Math.sin(bearing), y: -Math.cos(bearing) };
    return {
        position: [
            stellarPosition[0] + outward.x * offset,
            stellarPosition[1] + outward.y * offset,
        ],
        rotation: bearing,
        origin: 'stellar',
    };
}

/**
 * Choose how this ship enters the world. Stellars are only usable if the
 * caller could resolve their positions, so a system of bare rocks falls back
 * to hyperspace arrivals.
 */
export function chooseArrivalPlacement(
    system: ArrivalSystem,
    neighbourPositions: ReadonlyMap<string, readonly [number, number]>,
    stellarPositions: readonly (readonly [number, number])[],
    random: ArrivalRandom,
    launchShare = STELLAR_LAUNCH_SHARE,
): ArrivalPlacement | undefined {
    if (stellarPositions.length > 0 && sample(random) < launchShare) {
        const stellar = pick(stellarPositions, random);
        if (stellar) {
            return stellarLaunch(stellar, random);
        }
    }
    return hyperspaceEntry(system, neighbourPositions, random);
}
