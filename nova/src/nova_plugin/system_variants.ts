import { SystemData } from 'novadatainterface/SystemData';
import { evaluateTestExpression } from './ncb';

/**
 * Storyline copies of systems and stellars.
 *
 * Retail Nova expresses story changes by shipping several sÿst resources for
 * one place (Sol 130/531, Glimmer 193/677/678/759/760/761, ...). They share
 * name and map position, and each carries a visibility expression over the
 * control bits. Neighbours usually link to only ONE copy (often a hidden one),
 * and the copies list their own spöb copies (Earth 128 in Sol 130, Earth 426
 * in Sol 531), so every question of the form "is this the same place?" or
 * "where does this jump arrive?" has to go through the copy that is visible
 * for the pilot's current bits. This module is the one place that answers it.
 *
 * Retail data is not always exclusive: some bit combinations show two copies
 * (e.g. Aldebaran 141/532 with b147) or none (Pentori 428/622 before b9500).
 * `visibleVariant` resolves both deterministically. With several visible, the
 * highest resource ID wins: in every overlapping retail group that is the
 * later story stage (Aldebaran 532 with Sol 531, Procyon 1124 after b40,
 * Glimmer 761 after b6302, Outbound 542 after b3009). With none visible, the
 * original (lowest ID) copy is used.
 */

export type MissionBitsLike = ReadonlySet<number> | readonly boolean[] | undefined;
export type VariantSystem = Pick<SystemData, 'id' | 'name' | 'position' | 'visibility'>
    & Partial<Pick<SystemData, 'planets' | 'links'>>;

/**
 * Whether a sÿst is visible for these control bits. Unreadable bits (for
 * example a revoked Immer draft) count as "no bits set" rather than making
 * every hidden copy visible.
 */
export function isSystemVisible(
    system: Pick<SystemData, 'visibility'> | undefined,
    missionBits: MissionBitsLike,
): boolean {
    if (!system?.visibility) {
        return true;
    }
    try {
        return evaluateTestExpression(system.visibility,
            { missionBits: missionBits ?? new Set() });
    } catch {
        try {
            return evaluateTestExpression(system.visibility,
                { missionBits: new Set() });
        } catch {
            // An unparseable expression is ignored, as retail does.
            return true;
        }
    }
}

function numeric(id: string): number {
    const match = /(\d+)$/.exec(id);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function bare(id: string): string {
    return String(id).replace(/^.*:/, '');
}

function placeKey(system: Partial<Pick<SystemData, 'id' | 'name' | 'position'>>): string {
    const name = (system.name ?? '').trim().toLowerCase();
    if (!name || !Array.isArray(system.position)) {
        // Without both there is no evidence of a copy; keep it on its own.
        return `id:${system.id ?? Math.random()}`;
    }
    return `${system.position[0]},${system.position[1]}|${name}`;
}

/**
 * Groups every system with its storyline copies. Build it once per catalog
 * (it is cached per systems array/map) and ask it everything else.
 */
export class SystemVariantIndex {
    private readonly byId = new Map<string, VariantSystem>();
    private readonly groupOf = new Map<string, readonly string[]>();
    private readonly planetOwners = new Map<string, string[]>();

    constructor(systems: Iterable<VariantSystem>) {
        const groups = new Map<string, string[]>();
        for (const system of systems) {
            this.byId.set(system.id, system);
            this.byId.set(bare(system.id), system);
            const key = placeKey(system);
            groups.set(key, [...(groups.get(key) ?? []), system.id]);
            for (const planet of system.planets ?? []) {
                const owners = this.planetOwners.get(bare(planet)) ?? [];
                owners.push(system.id);
                this.planetOwners.set(bare(planet), owners);
            }
        }
        for (const ids of groups.values()) {
            ids.sort((a, b) => numeric(a) - numeric(b));
            for (const id of ids) {
                this.groupOf.set(id, ids);
                this.groupOf.set(bare(id), ids);
            }
        }
    }

    get(id: string | undefined): VariantSystem | undefined {
        return id === undefined ? undefined : this.byId.get(id) ?? this.byId.get(bare(id));
    }

    /** Every copy of this system, the original (lowest ID) first. */
    variantsOf(id: string): readonly string[] {
        return this.groupOf.get(id) ?? this.groupOf.get(bare(id)) ?? [id];
    }

    /** Whether two system IDs are copies of one place. */
    same(a: string | undefined, b: string | undefined): boolean {
        if (!a || !b) return false;
        if (a === b || bare(a) === bare(b)) return true;
        return this.variantsOf(a).some(id => bare(id) === bare(b));
    }

    isVisible(id: string, missionBits: MissionBitsLike): boolean {
        return isSystemVisible(this.get(id), missionBits);
    }

    /** The copy of this place that exists for these bits. */
    visibleVariant(id: string, missionBits: MissionBitsLike): string {
        const variants = this.variantsOf(id);
        for (let i = variants.length - 1; i >= 0; i--) {
            if (this.isVisible(variants[i], missionBits)) {
                return variants[i];
            }
        }
        return variants[0] ?? this.get(id)?.id ?? id;
    }

    /** Whether this exact copy is the one that exists for these bits. */
    isLive(id: string, missionBits: MissionBitsLike): boolean {
        return bare(this.visibleVariant(id, missionBits)) === bare(id);
    }

    /** Systems that list this stellar. */
    systemsOfPlanet(planetId: string): readonly string[] {
        return this.planetOwners.get(bare(planetId)) ?? [];
    }

    /**
     * Whether a stellar exists for these bits, i.e. at least one visible
     * system lists it. Stellars no system lists are treated as existing.
     */
    isPlanetVisible(planetId: string, missionBits: MissionBitsLike): boolean {
        const owners = this.systemsOfPlanet(planetId);
        return owners.length === 0
            || owners.some(owner => this.isLive(owner, missionBits));
    }

    /**
     * The system a stellar is reached through for these bits: a visible
     * system listing it, else the visible copy of any system listing it.
     */
    visibleSystemOfPlanet(planetId: string, missionBits: MissionBitsLike): string | undefined {
        const owners = this.systemsOfPlanet(planetId);
        return owners.find(owner => this.isLive(owner, missionBits))
            ?? (owners[0] ? this.visibleVariant(owners[0], missionBits) : undefined);
    }

    /**
     * The copy of a stellar that exists for these bits: the same-named
     * stellar listed by the live copy of its system (Earth 426 -> Earth 128
     * while Sol 130 is live). Returns the stellar itself when it exists or no
     * copy is found.
     */
    livePlanetCopy(
        planetId: string,
        missionBits: MissionBitsLike,
        getPlanet: (id: string) => { name?: string } | undefined,
    ): string {
        if (this.isPlanetVisible(planetId, missionBits)) return planetId;
        const name = getPlanet(planetId)?.name?.trim().toLowerCase();
        const owner = this.systemsOfPlanet(planetId)[0];
        if (!name || !owner) return planetId;
        const live = this.get(this.visibleVariant(owner, missionBits));
        return live?.planets?.find(candidate =>
            getPlanet(candidate)?.name?.trim().toLowerCase() === name) ?? planetId;
    }

    /** Whether the stellar is in this place (in any copy of the system). */
    planetInPlace(planetId: string, systemId: string): boolean {
        return this.systemsOfPlanet(planetId).some(owner => this.same(owner, systemId));
    }
}

const indexCache = new WeakMap<object, SystemVariantIndex>();
const gettableCache = new WeakMap<object, { size: number, index: SystemVariantIndex }>();

/**
 * An index over every system a Gettable-style catalog has loaded (the browser
 * preloads all of them). Rebuilt only when more systems have loaded.
 */
export function variantIndexForCatalog(catalog: object | undefined): SystemVariantIndex | undefined {
    if (!catalog) return undefined;
    const source = catalog as {
        gotten?: Record<string, VariantSystem>,
        map?: Map<string, VariantSystem>,
    };
    const values = source.map instanceof Map
        ? [...source.map.values()]
        : Object.values(source.gotten ?? {});
    if (values.length === 0) return undefined;
    const cached = gettableCache.get(catalog);
    if (cached && cached.size === values.length) return cached.index;
    const index = new SystemVariantIndex(values);
    gettableCache.set(catalog, { size: values.length, index });
    return index;
}

/** A cached index for a systems array, map, or Gettable-like catalog. */
export function variantIndexFor(
    systems: Iterable<VariantSystem> | ReadonlyMap<string, VariantSystem>,
): SystemVariantIndex {
    const key = systems as object;
    let index = indexCache.get(key);
    if (!index) {
        const values = systems instanceof Map
            ? systems.values() : systems as Iterable<VariantSystem>;
        index = new SystemVariantIndex(values);
        indexCache.set(key, index);
    }
    return index;
}

export interface GalaxyPlanet {
    id: string;
    systemId?: string;
}

/**
 * The galaxy as it exists for these bits: hidden copies removed, links that
 * point at a hidden copy redirected to the live copy, and every stellar that
 * only exists in a hidden copy dropped. Mission offers, random destinations
 * and route distances must be computed on this, never on the raw catalog.
 */
export function visibleGalaxy<S extends { id: string, links?: readonly string[] },
    P extends GalaxyPlanet>(
    systems: readonly S[],
    planets: readonly P[],
    missionBits: MissionBitsLike,
): { systems: S[], planets: (P & { systemId?: string })[], index: SystemVariantIndex } {
    const index = variantIndexFor(systems as unknown as readonly VariantSystem[]);
    const liveSystems = systems
        .filter(system => index.isLive(system.id, missionBits))
        .map(system => {
            if (!system.links) return system;
            const links = [...new Set(system.links.map(link =>
                index.get(link) ? index.visibleVariant(link, missionBits) : link))]
                .filter(link => bare(link) !== bare(system.id));
            return { ...system, links };
        });
    const livePlanets = planets
        .filter(planet => index.isPlanetVisible(planet.id, missionBits))
        .map(planet => {
            const systemId = index.visibleSystemOfPlanet(planet.id, missionBits);
            return systemId && systemId !== planet.systemId
                ? { ...planet, systemId } : planet;
        });
    return { systems: liveSystems, planets: livePlanets, index };
}

/**
 * The visible system a hyperjump to `target` should really arrive in. A hidden
 * copy is swapped for the visible copy among the current system's links, then
 * for the visible copy anywhere in `index` when one is supplied.
 */
export function visibleJumpTarget(
    target: string,
    links: readonly string[],
    missionBits: MissionBitsLike,
    getSystem: (id: string) => Pick<SystemData, 'name' | 'position' | 'visibility'> | undefined,
    index?: SystemVariantIndex,
): string {
    if (index?.get(target)) {
        return index.visibleVariant(target, missionBits);
    }
    const data = getSystem(target);
    if (!data || isSystemVisible(data, missionBits)) {
        return target;
    }
    for (const link of links) {
        const candidate = getSystem(link);
        if (!candidate || link === target) continue;
        if (placeKey(candidate) === placeKey(data)
            && isSystemVisible(candidate, missionBits)) {
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

/**
 * Whether two systems are the same place. Copies share BOTH name and map
 * position in retail data; requiring both avoids treating unrelated systems
 * that merely share a name (or a coordinate) as one.
 */
export function areSystemsSameOrVariants(
    sysA: string | undefined,
    sysB: string | undefined,
    systems?: SystemLookup,
): boolean {
    if (!sysA || !sysB) return false;
    if (sysA === sysB) return true;
    if (bare(sysA) === bare(sysB)) return true;
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
    return placeKey(dataA) === placeKey(dataB);
}

/**
 * Checks whether a planet ID belongs to a target star system or any storyline
 * copy of it (e.g. Brass 503 listed in Glimmer 759 while the pilot is in 761).
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
        if (sys?.planets?.includes(planetId) && placeKey(sys) === placeKey(currentSystem)) {
            return true;
        }
    }
    return false;
}
