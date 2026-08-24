/**
 * EV Nova's encoded stellar and system selectors.
 *
 * Resource IDs are one-based (normally `nova:128` and up), while the
 * government selector ranges contain government indexes.  The distinction is
 * important: a government value of 128 means government index 0, whereas a
 * stellar value of 128 means stellar resource ID 128.
 */

export interface StellarPlanet {
    id: string;
    inhabited?: boolean;
    government?: number;
    systemId?: string;
}

export interface StellarSystem {
    id: string;
    links?: readonly string[];
    planets?: readonly string[];
    government?: number;
}

export interface GovernmentRelation {
    id?: string | number;
    index?: number;
    /** Class numbers, not government IDs. */
    classes?: readonly (string | number)[];
    /** Class numbers allied with or opposed by this government. */
    allies?: readonly (string | number)[];
    enemies?: readonly (string | number)[];
}

export interface StellarSelectorContext {
    planets?: readonly StellarPlanet[];
    systems?: readonly StellarSystem[];
    governments?: readonly GovernmentRelation[];
    governmentRelations?:
        | ReadonlyMap<number, GovernmentRelation>
        | Readonly<Record<string, GovernmentRelation>>;
    currentPlanetId?: string;
    currentSystemId?: string;
    initialPlanetId?: string;
    initialSystemId?: string;
    travelPlanetId?: string;
    returnPlanetId?: string;
    random?: () => number;
}

export type StellarSelectorDomain =
    | 'availability'
    | 'destination'
    | 'system';

export interface SelectorResolution {
    selectorValue: number;
    candidates: string[];
    selected?: string;
    wildcard: boolean;
}

const STELLAR_MIN = 128;
const STELLAR_MAX = 2175;
const SYSTEM_ADJACENCY_MIN = 5000;
const SYSTEM_ADJACENCY_MAX = 7047;
const GOVERNMENT_RANDOM = 9999;
const GOVERNMENT_MIN = 10000;
const GOVERNMENT_MAX = 10255;
const GOVERNMENT_ALLY_MIN = 15000;
const GOVERNMENT_ALLY_MAX = 15255;
const GOVERNMENT_OTHER_MIN = 20000;
const GOVERNMENT_OTHER_MAX = 20255;
const GOVERNMENT_ENEMY_MIN = 25000;
const GOVERNMENT_ENEMY_MAX = 25255;
const GOVERNMENT_CLASS_MIN = 30000;
const GOVERNMENT_CLASS_MAX = 30255;
const GOVERNMENT_NOT_CLASS_MIN = 31000;
const GOVERNMENT_NOT_CLASS_MAX = 31255;

function numericId(id: string | number | undefined): number | undefined {
    if (typeof id === 'number') {
        return Number.isFinite(id) ? id : undefined;
    }
    if (typeof id !== 'string') {
        return undefined;
    }
    const match = /^(?:[^:]+:)?(-?\d+)$/.exec(id);
    return match ? Number(match[1]) : undefined;
}

export function sameResourceId(a: string | undefined, b: string | undefined) {
    if (!a || !b) {
        return false;
    }
    return a === b || numericId(a) === numericId(b);
}

export function novaResourceId(number: number): string {
    return `nova:${number}`;
}

/**
 * Government fields in spöb/sÿst resources contain government IDs.  The
 * encoded mission ranges, and the relation arrays in gövt, contain indexes.
 */
export function governmentIndex(value: string | number | undefined):
    number | undefined {
    const number = numericId(value);
    if (number === undefined || number < 0) {
        return undefined;
    }
    return number >= 128 && number <= 383 ? number - 128 : number;
}

function randomValue(random: () => number): number {
    const value = random();
    return Number.isFinite(value)
        ? Math.min(0.9999999999999999, Math.max(0, value))
        : 0;
}

function randomCandidate(
    candidates: readonly string[],
    random: () => number,
): string | undefined {
    if (candidates.length === 0) {
        return undefined;
    }
    return candidates[Math.floor(randomValue(random) * candidates.length)];
}

function governmentForIndex(
    index: number,
    context: StellarSelectorContext,
): GovernmentRelation | undefined {
    for (const relation of context.governments ?? []) {
        const relationIndex = relation.index ?? governmentIndex(relation.id);
        if (relationIndex === index) {
            return relation;
        }
    }

    const relations = context.governmentRelations;
    if (relations) {
        if (typeof (relations as ReadonlyMap<number, GovernmentRelation>).get
            === 'function') {
            const map = relations as ReadonlyMap<number, GovernmentRelation>;
            return map.get(index) ?? map.get(index + 128);
        }
        const record = relations as Readonly<Record<string, GovernmentRelation>>;
        return record[String(index)] ?? record[String(index + 128)];
    }
    return undefined;
}

function classValues(
    values: readonly (string | number)[] | undefined,
): Set<number> {
    return new Set(
        (values ?? [])
            .map(value => numericId(value))
            .filter((value): value is number =>
                value !== undefined && value >= 0),
    );
}

function allGovernmentRelations(
    context: StellarSelectorContext,
): Array<readonly [number, GovernmentRelation]> {
    const relations = new Map<number, GovernmentRelation>();
    for (const relation of context.governments ?? []) {
        const index = relation.index ?? governmentIndex(relation.id);
        if (index !== undefined) {
            relations.set(index, relation);
        }
    }
    const governmentRelations = context.governmentRelations;
    if (governmentRelations) {
        if (typeof (governmentRelations as ReadonlyMap<
            number, GovernmentRelation>).get === 'function') {
            const map = governmentRelations as ReadonlyMap<
                number, GovernmentRelation>;
            for (const [index, relation] of map.entries()) {
                if (!relations.has(index)) {
                    relations.set(index, relation);
                }
            }
        } else {
            for (const [key, relation] of Object.entries(
                governmentRelations)) {
                const index = Number(key);
                if (Number.isFinite(index) && !relations.has(index)) {
                    relations.set(index, relation);
                }
            }
        }
    }
    return [...relations.entries()];
}

function classMateIndexes(
    government: number,
    context: StellarSelectorContext,
): Set<number> {
    const relation = governmentForIndex(government, context);
    const classes = classValues(relation?.classes);
    const indexes = new Set<number>();
    for (const [index, other] of allGovernmentRelations(context)) {
        if ([...classes].some(classValue =>
            classValues(other.classes).has(classValue))) {
            indexes.add(index);
        }
    }
    // A caller may provide only the target government relation.
    if (relation) {
        indexes.add(government);
    }
    return indexes;
}

function planetSystemId(
    planet: StellarPlanet,
    context: StellarSelectorContext,
): string | undefined {
    if (planet.systemId) {
        return planet.systemId;
    }
    return (context.systems ?? []).find(system =>
        (system.planets ?? []).some(id => sameResourceId(id, planet.id)))?.id;
}

function systemForId(
    id: string | undefined,
    context: StellarSelectorContext,
): StellarSystem | undefined {
    return (context.systems ?? []).find(system => sameResourceId(system.id, id));
}

function systemIsAdjacentTo(
    system: StellarSystem,
    targetId: string | undefined,
    targetEncoded: number | undefined,
): boolean {
    if (targetId && (system.links ?? []).some(link =>
        sameResourceId(link, targetId))) {
        return true;
    }
    return targetEncoded !== undefined
        && (system.links ?? []).some(link =>
            numericId(link) === targetEncoded
            || numericId(link) === targetEncoded + 128);
}

type GovernmentSelector =
    | { relation: 'government', government: number }
    | { relation: 'ally', government: number }
    | { relation: 'other', government: number }
    | { relation: 'enemy', government: number }
    | { relation: 'class', government: number }
    | { relation: 'notClass', government: number };

function decodeGovernmentSelector(
    selectorValue: number,
): GovernmentSelector | undefined {
    if (selectorValue >= GOVERNMENT_MIN
        && selectorValue <= GOVERNMENT_MAX) {
        return {
            relation: 'government',
            government: selectorValue - GOVERNMENT_MIN,
        };
    }
    if (selectorValue >= GOVERNMENT_ALLY_MIN
        && selectorValue <= GOVERNMENT_ALLY_MAX) {
        return {
            relation: 'ally',
            government: selectorValue - GOVERNMENT_ALLY_MIN,
        };
    }
    if (selectorValue >= GOVERNMENT_OTHER_MIN
        && selectorValue <= GOVERNMENT_OTHER_MAX) {
        return {
            relation: 'other',
            government: selectorValue - GOVERNMENT_OTHER_MIN,
        };
    }
    if (selectorValue >= GOVERNMENT_ENEMY_MIN
        && selectorValue <= GOVERNMENT_ENEMY_MAX) {
        return {
            relation: 'enemy',
            government: selectorValue - GOVERNMENT_ENEMY_MIN,
        };
    }
    if (selectorValue >= GOVERNMENT_CLASS_MIN
        && selectorValue <= GOVERNMENT_CLASS_MAX) {
        return {
            relation: 'class',
            government: selectorValue - GOVERNMENT_CLASS_MIN,
        };
    }
    if (selectorValue >= GOVERNMENT_NOT_CLASS_MIN
        && selectorValue <= GOVERNMENT_NOT_CLASS_MAX) {
        return {
            relation: 'notClass',
            government: selectorValue - GOVERNMENT_NOT_CLASS_MIN,
        };
    }
    return undefined;
}

function governmentMatches(
    value: number | undefined,
    selector: GovernmentSelector,
    context: StellarSelectorContext,
): boolean {
    const actual = governmentIndex(value);
    if (selector.relation === 'other') {
        return actual !== selector.government;
    }
    if (actual === undefined) {
        return selector.relation === 'notClass';
    }

    switch (selector.relation) {
        case 'government':
            return actual === selector.government;
        case 'ally': {
            const target = governmentForIndex(selector.government, context);
            const actualRelation = governmentForIndex(actual, context);
            const allies = classValues(target?.allies);
            return [...allies].some(classValue =>
                classValues(actualRelation?.classes).has(classValue));
        }
        case 'enemy': {
            const target = governmentForIndex(selector.government, context);
            const actualRelation = governmentForIndex(actual, context);
            const enemies = classValues(target?.enemies);
            return [...enemies].some(classValue =>
                classValues(actualRelation?.classes).has(classValue));
        }
        case 'class':
            return classMateIndexes(selector.government, context).has(actual);
        case 'notClass':
            return !classMateIndexes(selector.government, context).has(actual);
        default:
            return false;
    }
}

function allPlanets(context: StellarSelectorContext): readonly StellarPlanet[] {
    return context.planets ?? [];
}

function destinationPlanetCandidates(
    selectorValue: number,
    context: StellarSelectorContext,
): string[] {
    const planets = allPlanets(context);
    if (selectorValue === -1) {
        // -1 is "no specific stellar" for destinations, but the full set is
        // useful to callers inspecting the candidate space.
        return planets.map(planet => planet.id);
    }
    if (selectorValue === -2 || selectorValue === -3) {
        return planets
            .filter(planet => selectorValue === -2
                ? planet.inhabited !== false
                : planet.inhabited === false)
            .map(planet => planet.id);
    }
    if (selectorValue === -4) {
        return context.initialPlanetId
            ? [context.initialPlanetId]
            : [];
    }
    if (selectorValue === GOVERNMENT_RANDOM) {
        return planets
            .filter(planet => planet.inhabited !== false)
            .map(planet => planet.id);
    }
    if (selectorValue >= STELLAR_MIN && selectorValue <= STELLAR_MAX) {
        return planets
            .filter(planet => numericId(planet.id) === selectorValue)
            .map(planet => planet.id);
    }

    const governmentSelector = decodeGovernmentSelector(selectorValue);
    if (!governmentSelector) {
        return [];
    }
    return planets
        .filter(planet => governmentMatches(
            planet.government, governmentSelector, context))
        .map(planet => planet.id);
}

function availabilityPlanetCandidates(
    selectorValue: number,
    context: StellarSelectorContext,
): string[] {
    const planets = allPlanets(context);
    if (selectorValue === -1 || selectorValue === GOVERNMENT_RANDOM) {
        return planets
            .filter(planet => planet.inhabited !== false)
            .map(planet => planet.id);
    }
    if (selectorValue >= STELLAR_MIN && selectorValue <= STELLAR_MAX) {
        return planets
            .filter(planet => numericId(planet.id) === selectorValue)
            .map(planet => planet.id);
    }
    if (selectorValue >= SYSTEM_ADJACENCY_MIN
        && selectorValue <= SYSTEM_ADJACENCY_MAX) {
        const encodedSystem = selectorValue - SYSTEM_ADJACENCY_MIN;
        return planets
            .filter(planet => {
                const systemId = planetSystemId(planet, context);
                const system = systemForId(systemId, context);
                return system !== undefined
                    && systemIsAdjacentTo(system, undefined, encodedSystem);
            })
            .map(planet => planet.id);
    }

    const governmentSelector = decodeGovernmentSelector(selectorValue);
    if (!governmentSelector) {
        return [];
    }
    return planets
        .filter(planet => governmentMatches(
            planet.government, governmentSelector, context))
        .map(planet => planet.id);
}

function availabilityMatchesCurrentSystem(
    selectorValue: number,
    context: StellarSelectorContext,
): boolean {
    if (selectorValue < SYSTEM_ADJACENCY_MIN
        || selectorValue > SYSTEM_ADJACENCY_MAX) {
        return false;
    }
    const currentSystem = systemForId(context.currentSystemId, context);
    if (!currentSystem) {
        return false;
    }
    const encodedSystem = selectorValue - SYSTEM_ADJACENCY_MIN;
    return systemIsAdjacentTo(currentSystem, undefined, encodedSystem);
}

/**
 * Return the planets selected by a raw AvailStel or destination value.
 */
export function getStellarSelectorCandidates(
    selectorValue: number,
    context: StellarSelectorContext,
    domain: 'availability' | 'destination' = 'destination',
): string[] {
    return domain === 'availability'
        ? availabilityPlanetCandidates(selectorValue, context)
        : destinationPlanetCandidates(selectorValue, context);
}

/**
 * Test one planet against an AvailStel selector.  Destination selectors are
 * also accepted for callers that need to inspect a concrete target.
 */
export function matchesStellarSelector(
    selectorValue: number,
    planet: StellarPlanet,
    context: StellarSelectorContext,
    domain: 'availability' | 'destination' = 'availability',
): boolean {
    if (domain === 'availability'
        && (selectorValue === -1 || selectorValue === GOVERNMENT_RANDOM)) {
        return planet.inhabited !== false;
    }
    if (domain === 'availability'
        && selectorValue >= SYSTEM_ADJACENCY_MIN
        && selectorValue <= SYSTEM_ADJACENCY_MAX) {
        return availabilityMatchesCurrentSystem(selectorValue, {
            ...context,
            currentSystemId: planetSystemId(planet, context),
        });
    }
    if (domain === 'destination' && selectorValue === -1) {
        return true;
    }
    return getStellarSelectorCandidates(selectorValue, context, domain)
        .some(id => sameResourceId(id, planet.id));
}

function systemGovernmentMatches(
    system: StellarSystem,
    selector: GovernmentSelector,
    context: StellarSelectorContext,
): boolean {
    return governmentMatches(system.government, selector, context);
}

function systemForPlanetId(
    planetId: string | undefined,
    context: StellarSelectorContext,
): StellarSystem | undefined {
    if (!planetId) {
        return undefined;
    }
    const planet = (context.planets ?? []).find(entry =>
        sameResourceId(entry.id, planetId));
    return systemForId(planetSystemId(planet ?? { id: planetId }, context), context);
}

function adjacentSystems(
    systemId: string | undefined,
    context: StellarSelectorContext,
): string[] {
    const system = systemForId(systemId, context);
    if (!system) {
        return [];
    }
    return (system.links ?? []).slice();
}

/**
 * Return systems selected by a raw ShipSyst value.
 */
export function getSystemSelectorCandidates(
    selectorValue: number,
    context: StellarSelectorContext,
): string[] {
    const systems = context.systems ?? [];
    switch (selectorValue) {
        case -1:
            return context.initialSystemId || context.currentSystemId
                ? [context.initialSystemId ?? context.currentSystemId!]
                : [];
        case -2:
            return systems.map(system => system.id);
        case -3: {
            const system = systemForPlanetId(context.travelPlanetId, context);
            return system ? [system.id] : [];
        }
        case -4: {
            const system = systemForPlanetId(context.returnPlanetId, context);
            return system ? [system.id] : [];
        }
        case -5:
            return adjacentSystems(
                context.initialSystemId ?? context.currentSystemId, context);
        case -6:
            return context.currentSystemId ? [context.currentSystemId] : [];
        case GOVERNMENT_RANDOM:
            return systems.map(system => system.id);
        default:
            break;
    }

    if (selectorValue >= STELLAR_MIN && selectorValue <= STELLAR_MAX) {
        return systems
            .filter(system => numericId(system.id) === selectorValue)
            .map(system => system.id);
    }
    const governmentSelector = decodeGovernmentSelector(selectorValue);
    if (!governmentSelector) {
        return [];
    }
    return systems
        .filter(system => systemGovernmentMatches(
            system, governmentSelector, context))
        .map(system => system.id);
}

export function resolveStellarSelector(
    selectorValue: number,
    context: StellarSelectorContext,
    domain: 'availability' | 'destination' = 'destination',
): SelectorResolution {
    const candidates = getStellarSelectorCandidates(
        selectorValue, context, domain);
    const random = context.random ?? Math.random;
    const wildcard = domain === 'destination' && selectorValue === -1;
    const selected = wildcard
        ? undefined
        : (selectorValue === -2
            || selectorValue === -3
            || selectorValue === GOVERNMENT_RANDOM
            || decodeGovernmentSelector(selectorValue) !== undefined)
            ? randomCandidate(candidates, random)
            : candidates[0];
    return { selectorValue, candidates, selected, wildcard };
}

export function resolveSystemSelector(
    selectorValue: number,
    context: StellarSelectorContext,
): SelectorResolution {
    const candidates = getSystemSelectorCandidates(selectorValue, context);
    const random = context.random ?? Math.random;
    const selected = selectorValue === -2
        || selectorValue === GOVERNMENT_RANDOM
        || decodeGovernmentSelector(selectorValue) !== undefined
        ? randomCandidate(candidates, random)
        : candidates[0];
    return {
        selectorValue,
        candidates,
        selected,
        wildcard: false,
    };
}

/**
 * Expose the predicate form for code that needs to evaluate a selector
 * without choosing a random destination.
 */
export function stellarSelectorPredicate(
    selectorValue: number,
    context: StellarSelectorContext,
    domain: 'availability' | 'destination' = 'availability',
): (planet: StellarPlanet) => boolean {
    return planet => matchesStellarSelector(
        selectorValue, planet, context, domain);
}

export const STELLAR_SELECTOR_RANGES = {
    specificStellar: [STELLAR_MIN, STELLAR_MAX] as const,
    adjacentSystem: [SYSTEM_ADJACENCY_MIN, SYSTEM_ADJACENCY_MAX] as const,
    // The Bible prints this family as 9999-10255. 9999 is the random/any
    // sentinel; indexed governments begin at 10000 (see the Bible's offset
    // note), through index 255 at 10255.
    government: [GOVERNMENT_RANDOM, GOVERNMENT_MAX] as const,
    governmentIndex: [GOVERNMENT_MIN, GOVERNMENT_MAX] as const,
    ally: [GOVERNMENT_ALLY_MIN, GOVERNMENT_ALLY_MAX] as const,
    other: [GOVERNMENT_OTHER_MIN, GOVERNMENT_OTHER_MAX] as const,
    enemy: [GOVERNMENT_ENEMY_MIN, GOVERNMENT_ENEMY_MAX] as const,
    classMate: [GOVERNMENT_CLASS_MIN, GOVERNMENT_CLASS_MAX] as const,
    notClassMate: [GOVERNMENT_NOT_CLASS_MIN, GOVERNMENT_NOT_CLASS_MAX] as const,
} as const;
