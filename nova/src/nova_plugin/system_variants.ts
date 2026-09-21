import { SystemData } from 'novadatainterface/SystemData';

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
