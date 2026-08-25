import { SystemData } from 'novadatainterface/SystemData';

type RoutableSystem = Pick<SystemData, 'id' | 'links'>;

function knownSystemSet(
    exploredSystems: readonly string[] | undefined,
    source: string,
): Set<string> | undefined {
    if (!exploredSystems || exploredSystems.length === 0) {
        return;
    }
    const known = new Set(exploredSystems);
    known.add(source);
    return known;
}

/**
 * Return the shortest hyperlink routes from one source.
 *
 * Hyperlinks are treated as bidirectional (the map draws them that way), and
 * an empty knowledge list preserves the behavior of legacy saves that did not
 * track explored systems. EV Nova links are unweighted, so one breadth-first
 * traversal produces the route for every destination.
 */
export function shortestRoutes(
    systems: readonly RoutableSystem[],
    source: string,
    exploredSystems?: readonly string[],
): Map<string, string[]> {
    const known = knownSystemSet(exploredSystems, source);
    const byId = new Map(systems.map(system => [system.id, system]));
    const paths = new Map<string, string[]>(
        systems.map(system => [system.id, []]),
    );

    if (!byId.has(source)) {
        return paths;
    }

    const neighbors = new Map<string, Set<string>>();
    for (const system of systems) {
        if (known && !known.has(system.id)) {
            continue;
        }
        const systemNeighbors = neighbors.get(system.id) ?? new Set<string>();
        for (const linked of system.links) {
            if (!byId.has(linked) || (known && !known.has(linked))) {
                continue;
            }
            systemNeighbors.add(linked);
            const reverse = neighbors.get(linked) ?? new Set<string>();
            reverse.add(system.id);
            neighbors.set(linked, reverse);
        }
        neighbors.set(system.id, systemNeighbors);
    }

    // Sort each frontier before expanding it. This retains the deterministic
    // tie-breaking of the map's previous shortest-path implementation while
    // still doing only one traversal from the current system.
    let frontier = [source];
    const visited = new Set(frontier);
    while (frontier.length > 0) {
        const nextFrontier: string[] = [];
        for (const current of frontier.sort((a, b) => a.localeCompare(b))) {
            const path = paths.get(current);
            if (!path) {
                continue;
            }
            for (const neighbor of neighbors.get(current) ?? []) {
                if (visited.has(neighbor)) {
                    continue;
                }
                visited.add(neighbor);
                paths.set(neighbor, [...path, neighbor]);
                nextFrontier.push(neighbor);
            }
        }
        frontier = nextFrontier;
    }
    return paths;
}

/**
 * Return the shortest hyperlink route, excluding the current system.
 */
export function shortestRoute(
    systems: readonly Pick<SystemData, 'id' | 'links'>[],
    source: string,
    destination: string,
    exploredSystems?: readonly string[],
): string[] {
    return shortestRoutes(systems, source, exploredSystems)
        .get(destination) ?? [];
}
