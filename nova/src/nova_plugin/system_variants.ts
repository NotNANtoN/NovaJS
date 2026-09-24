import { SystemData } from 'novadatainterface/SystemData';
import { evaluateTestExpression } from './ncb';

/**
 * Whether a sÿst is visible for these control bits. Retail keeps storyline
 * clones (Sol 130/531, Glimmer 193/759/760/761) at the same place and shows
 * exactly one of them according to its visibility expression.
 */
export function isSystemVisible(
    system: Pick<SystemData, 'visibility'> | undefined,
    missionBits: ReadonlySet<number> | readonly boolean[] | undefined,
): boolean {
    if (!system?.visibility) {
        return true;
    }
    try {
        return evaluateTestExpression(system.visibility,
            { missionBits: missionBits ?? new Set() });
    } catch {
        return false;
    }
}

/**
 * The visible system a hyperjump to `target` should really arrive in. A hidden
 * clone is swapped for the visible variant among the current system's links.
 */
export function visibleJumpTarget(
    target: string,
    links: readonly string[],
    missionBits: ReadonlySet<number> | readonly boolean[] | undefined,
    getSystem: (id: string) => Pick<SystemData, 'name' | 'position' | 'visibility'> | undefined,
): string {
    const data = getSystem(target);
    if (!data || isSystemVisible(data, missionBits)) {
        return target;
    }
    for (const link of links) {
        const candidate = getSystem(link);
        if (!candidate || link === target) continue;
        const samePlace = candidate.position && data.position
            && candidate.position[0] === data.position[0]
            && candidate.position[1] === data.position[1];
        const sameName = candidate.name && data.name
            && candidate.name.trim().toLowerCase() === data.name.trim().toLowerCase();
        if ((samePlace || sameName) && isSystemVisible(candidate, missionBits)) {
            return link;
        }
    }
    return target;
}

export type SystemLookup = {
    readonly getCached?: (id: string) => Pick<SystemData, 'name' | 'position'> | undefined;
    readonly get?: (id: string) => Promise<Pick<SystemData, 'name' | 'position'>> | Pick<SystemData, 'name' | 'position'> | undefined;
} | ReadonlyMap<string, Pick<SystemData, 'name' | 'position'>>
  | readonly Pick<SystemData, 'id' | 'name' | 'position'>[];

export function areSystemsSameOrVariants(
    sysA: string | undefined,
    sysB: string | undefined,
    systems?: SystemLookup,
): boolean {
    if (!sysA || !sysB) return false;
    if (sysA === sysB) return true;
    const bareA = String(sysA).replace(/^.*:/, '');
    const bareB = String(sysB).replace(/^.*:/, '');
    if (bareA === bareB) return true;
    if (!systems) return false;

    const getSys = (id: string): Pick<SystemData, 'name' | 'position'> | undefined => {
        if ('getCached' in systems && typeof (systems as any).getCached === 'function') {
            return (systems as any).getCached(id);
        }
        if (systems instanceof Map) {
            return systems.get(id);
        }
        if (Array.isArray(systems)) {
            return (systems as readonly any[]).find(s => s.id === id);
        }
        if (systems && typeof systems === 'object' && 'map' in systems && (systems as any).map instanceof Map) {
            return (systems as any).map.get(id);
        }
        return undefined;
    };

    const dataA = getSys(sysA);
    const dataB = getSys(sysB);
    if (!dataA || !dataB) return false;

    const samePos = dataA.position && dataB.position
        && dataA.position[0] === dataB.position[0]
        && dataA.position[1] === dataB.position[1];
    const sameName = dataA.name && dataB.name
        && dataA.name.trim().toLowerCase() === dataB.name.trim().toLowerCase();

    return Boolean(samePos || sameName);
}

/**
 * Checks whether a planet ID belongs to a target star system or any storyline clone/variant
 * sharing the same celestial position or canonical name (e.g. Glimmer 193/759/760/761).
 */
export async function isPlanetInSystem(
    planetId: string,
    currentSystem: SystemData | undefined,
    systemSource: { get: (id: string) => Promise<SystemData | undefined> | SystemData | undefined },
    allSystemIds: readonly string[] = [],
): Promise<boolean> {
    if (!currentSystem) return false;
    if (currentSystem.planets?.includes(planetId)) return true;

    for (const sysId of allSystemIds) {
        const sys = await systemSource.get(sysId);
        if (sys?.planets?.includes(planetId)) {
            const samePos = sys.position && currentSystem.position
                && sys.position[0] === currentSystem.position[0]
                && sys.position[1] === currentSystem.position[1];
            const sameName = sys.name && currentSystem.name
                && sys.name.trim().toLowerCase() === currentSystem.name.trim().toLowerCase();
            if (samePos || sameName || areSystemsSameOrVariants(sys.id, currentSystem.id, systemSource as any)) {
                return true;
            }
        }
    }
    return false;
}
