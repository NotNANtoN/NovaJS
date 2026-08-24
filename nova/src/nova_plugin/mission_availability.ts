import { MissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import type { PlayerState } from './player_state';
import { evaluateTestExpression } from './ncb';

/**
 * The small amount of stellar information needed by the availability rules.
 *
 * `destinationPlanets` and `destinationSystems` are optional because callers
 * that only need to check the offer location do not need to load the whole
 * galaxy. When they are supplied, they are also used to reject missions whose
 * fixed or random destinations cannot be resolved.
 */
export interface MissionPlanetSelector {
    id: string;
    inhabited?: boolean;
}

export interface MissionSystemSelector {
    id: string;
    links?: readonly string[];
    planets?: readonly string[];
}

export interface MissionAvailabilityInput {
    missionIds: readonly string[];
    missions: ReadonlyMap<string, MissionData>
        | Readonly<Record<string, MissionData>>;
    playerState: Pick<PlayerState, 'missionBits' | 'activeMissions'>;
    currentPlanet: MissionPlanetSelector;
    currentSystem: MissionSystemSelector;
    offerLocation: MissionOfferLocation;
    destinationPlanets?: readonly MissionPlanetSelector[];
    destinationSystems?: readonly MissionSystemSelector[];
    random?: () => number;
}

function numberFromNovaId(id: string): number | undefined {
    const match = /^(?:[^:]+:)?(\d+)$/.exec(id);
    return match ? Number(match[1]) : undefined;
}

function idForNovaNumber(number: number): string {
    return `nova:${number}`;
}

function hasPlanet(
    planets: readonly MissionPlanetSelector[] | undefined,
    selector: number,
): boolean {
    if (!planets) {
        // An omitted galaxy means that the caller did not ask us to validate
        // destinations. The availability result should still be useful.
        return true;
    }
    return planets.some(planet => numberFromNovaId(planet.id) === selector);
}

function selectorMatchesCurrentPlanet(
    selector: number,
    currentPlanet: MissionPlanetSelector,
    currentSystem: MissionSystemSelector,
): boolean {
    if (selector === -1) {
        // A landing planet is inhabited unless a caller explicitly says
        // otherwise. PlanetData currently has no government/inhabited field.
        return currentPlanet.inhabited !== false;
    }

    const currentPlanetNumber = numberFromNovaId(currentPlanet.id);
    if (selector >= 128 && selector <= 2175) {
        return currentPlanetNumber === selector;
    }

    // This is the one encoded selector that can be handled without government
    // data: 5000 + system ID means a stellar in an adjacent system.
    if (selector >= 5000 && selector <= 7047) {
        const adjacentSystem = selector - 5000;
        return (currentSystem.links ?? [])
            .some(systemId => numberFromNovaId(systemId) === adjacentSystem);
    }

    // Government, ally, enemy, and class-mate selectors need government data,
    // which is not part of the current SystemData interface.
    return false;
}

function destinationSelectorIsSatisfiable(
    selector: number,
    planets: readonly MissionPlanetSelector[] | undefined,
    systems: readonly MissionSystemSelector[] | undefined,
): boolean {
    switch (selector) {
        case -1:
        case -4:
            return true;
        case -2:
            return planets === undefined
                || planets.some(planet => planet.inhabited !== false);
        case -3:
            return planets === undefined
                || planets.some(planet => planet.inhabited === false);
        default:
            if (selector >= 128 && selector <= 2175) {
                return hasPlanet(planets, selector);
            }

            // The remaining encoded selectors (government, ally, enemy, and
            // class-mate ranges, as well as unsupported destination
            // adjacency selectors, are intentionally skipped until the
            // corresponding world metadata is available. Offering them would
            // create destinations that the phase-one runtime cannot resolve.
            return false;
    }
}

function destinationIsSatisfiable(
    mission: MissionData,
    input: MissionAvailabilityInput,
): boolean {
    return destinationSelectorIsSatisfiable(
        mission.travelStel,
        input.destinationPlanets,
        input.destinationSystems,
    ) && destinationSelectorIsSatisfiable(
        mission.returnStel,
        input.destinationPlanets,
        input.destinationSystems,
    );
}

function randomValue(random: () => number): number {
    return Math.min(0.9999999999999999, Math.max(0, random()));
}

function missionDataFor(
    missions: MissionAvailabilityInput['missions'],
    id: string,
): MissionData | undefined {
    if (missions instanceof Map) {
        return missions.get(id);
    }
    return (missions as Readonly<Record<string, MissionData>>)[id];
}

/**
 * Return missions that may be offered at the current stellar and menu.
 *
 * This deliberately covers the phase-one rules that can be evaluated from
 * PlayerState and the existing planet/system data: AvailStel, AvailLoc,
 * AvailRandom, AvailBits, active-mission exclusion, destination validity, and
 * the combat-mission stub. AvailRecord, AvailRating, AvailShipType, Require,
 * and government-based stellar selectors remain unavailable until their
 * corresponding player/world data is represented in NovaJS.
 */
export function getOfferableMissions(
    input: MissionAvailabilityInput,
): MissionData[] {
    const random = input.random ?? Math.random;
    const activeIds = new Set(
        input.playerState.activeMissions.map(mission => mission.missionId),
    );

    return input.missionIds
        .map(id => missionDataFor(input.missions, id))
        .filter((mission): mission is MissionData => mission !== undefined)
        .filter(mission => !activeIds.has(mission.id))
        .filter(mission => mission.availLoc === input.offerLocation)
        .filter(mission => mission.shipGoal < 0)
        .filter(mission => selectorMatchesCurrentPlanet(
            mission.availStel,
            input.currentPlanet,
            input.currentSystem,
        ))
        .filter(mission => {
            try {
                return evaluateAvailabilityBits(mission, input.playerState);
            } catch (error) {
                console.warn(`Skipping mission ${mission.id} with invalid AvailBits`, error);
                return false;
            }
        })
        .filter(mission => mission.availRandom > 0
            && (mission.availRandom >= 100
                || randomValue(random) < mission.availRandom / 100))
        .filter(mission => destinationIsSatisfiable(mission, input));
}

function evaluateAvailabilityBits(
    mission: MissionData,
    playerState: Pick<PlayerState, 'missionBits'>,
): boolean {
    return evaluateTestExpression(mission.availBits, {
        missionBits: playerState.missionBits,
    });
}

/**
 * Resolve a raw stellar selector to an ID for a newly accepted mission.
 *
 * `*` means any stellar, and is used for ReturnStel == -1. The return value is
 * intentionally undefined for government selectors because phase one does not
 * have government metadata to select a safe destination.
 */
export function resolveStellarSelector(
    selector: number,
    options: {
        initialPlanetId: string;
        planets?: readonly MissionPlanetSelector[];
        random?: () => number;
    },
): string | '*' | undefined {
    switch (selector) {
        case -1:
            return '*';
        case -4:
            return options.initialPlanetId;
        case -2:
        case -3: {
            const candidates = (options.planets ?? []).filter(planet =>
                selector === -2
                    ? planet.inhabited !== false
                    : planet.inhabited === false);
            if (candidates.length === 0) {
                return undefined;
            }
            const random = randomValue(options.random ?? Math.random);
            return candidates[Math.floor(random * candidates.length)].id;
        }
        default:
            if (selector >= 128 && selector <= 2175) {
                const matchingPlanet = options.planets?.find(planet =>
                    numberFromNovaId(planet.id) === selector);
                return matchingPlanet?.id ?? idForNovaNumber(selector);
            }
            return undefined;
    }
}

/**
 * Resolve the completion destination used by phase-one cargo missions.
 *
 * ReturnStel is authoritative when present. For a mission with no return
 * stellar and a travel drop-off, TravelStel is the useful completion point.
 */
export function resolveMissionCompletionDestination(
    mission: MissionData,
    initialPlanetId: string,
    options: {
        planets?: readonly MissionPlanetSelector[];
        random?: () => number;
    } = {},
): string | '*' | undefined {
    const selector = mission.returnStel === -1 && mission.dropOffMode === 0
        ? mission.travelStel
        : mission.returnStel;
    return resolveStellarSelector(selector, {
        initialPlanetId,
        ...options,
    });
}

