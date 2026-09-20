import { SystemData } from 'novadatainterface/SystemData';

export type RoutableSystem = Pick<SystemData, 'id' | 'links'> & {
    readonly position?: [number, number];
    readonly name?: string;
};

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
    allSystems?: readonly RoutableSystem[] | ReadonlyMap<string, RoutableSystem>,
): Map<string, string[]> {
    const known = knownSystemSet(exploredSystems, source);
    const byId = new Map(systems.map(system => [system.id, system]));
    const paths = new Map<string, string[]>(
        systems.map(system => [system.id, []]),
    );

    // Build active variant lookups to resolve storyline system clones (e.g. Glimmer/Sol variants)
    const activeByPos = new Map<string, string>();
    const activeByName = new Map<string, string>();
    for (const sys of systems) {
        if (sys.position) {
            activeByPos.set(`${sys.position[0]},${sys.position[1]}`, sys.id);
        }
        if (sys.name) {
            activeByName.set(sys.name.trim().toLowerCase(), sys.id);
        }
    }

    const resolveToActive = (id: string): string => {
        if (byId.has(id)) return id;
        if (allSystems) {
            const fullSys = allSystems instanceof Map
                ? allSystems.get(id)
                : (allSystems as readonly RoutableSystem[]).find(s => s.id === id);
            if (fullSys) {
                if (fullSys.position) {
                    const match = activeByPos.get(`${fullSys.position[0]},${fullSys.position[1]}`);
                    if (match) return match;
                }
                if (fullSys.name) {
                    const match = activeByName.get(fullSys.name.trim().toLowerCase());
                    if (match) return match;
                }
            }
        }
        return id;
    };

    const effectiveSource = resolveToActive(source);
    if (!byId.has(effectiveSource)) {
        return paths;
    }

    const neighbors = new Map<string, Set<string>>();
    for (const system of systems) {
        if (known && !known.has(system.id)) {
            continue;
        }
        const systemNeighbors = neighbors.get(system.id) ?? new Set<string>();
        for (const linked of system.links) {
            const resolvedLink = resolveToActive(linked);
            if (!byId.has(resolvedLink) || (known && !known.has(resolvedLink))) {
                continue;
            }
            systemNeighbors.add(resolvedLink);
            const reverse = neighbors.get(resolvedLink) ?? new Set<string>();
            reverse.add(system.id);
            neighbors.set(resolvedLink, reverse);
        }
        neighbors.set(system.id, systemNeighbors);
    }

    // Sort each frontier before expanding it. This retains the deterministic
    // tie-breaking of the map's previous shortest-path implementation while
    // still doing only one traversal from the current system.
    let frontier = [effectiveSource];
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
    systems: readonly RoutableSystem[],
    source: string,
    destination: string,
    exploredSystems?: readonly string[],
    allSystems?: readonly RoutableSystem[] | ReadonlyMap<string, RoutableSystem>,
): string[] {
    return shortestRoutes(systems, source, exploredSystems, allSystems)
        .get(destination) ?? [];
}
