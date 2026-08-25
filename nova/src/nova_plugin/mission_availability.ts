import { MissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import { getFreeSpace } from './player_state';
import type { PlayerState } from './player_state';
import { evaluateTestExpression } from './ncb';
import { ncbTestContext } from './ncb_runtime';
import type { OutfitsState } from './outfit_plugin';
import { clampRandom } from '../common/random';
import {
    GovernmentRelation,
    matchesStellarSelector,
    novaResourceId,
    resolveStellarSelector as resolveSelector,
    sameResourceId,
    StellarPlanet,
    StellarSelectorContext,
    StellarSystem,
} from './stellar_selector';

/**
 * The small amount of stellar information needed by the availability rules.
 *
 * `destinationPlanets` and `destinationSystems` are optional because callers
 * that only need to check the offer location do not need to load the whole
 * galaxy. When they are supplied, they are also used to reject missions whose
 * fixed or random destinations cannot be resolved.
 */
export type MissionPlanetSelector = StellarPlanet;
export type MissionSystemSelector = StellarSystem;

export interface MissionAvailabilityInput {
    missionIds: readonly string[];
    missions: ReadonlyMap<string, MissionData>
        | Readonly<Record<string, MissionData>>;
    playerState: Pick<
        PlayerState,
        'missionBits' | 'activeMissions' | 'gender' | 'exploredSystems'
    >
        & Partial<Pick<PlayerState, 'cargoCapacity' | 'holds' | 'shipId'>>;
    outfits?: OutfitsState;
    currentPlanet: MissionPlanetSelector;
    currentSystem: MissionSystemSelector;
    offerLocation: MissionOfferLocation;
    destinationPlanets?: readonly MissionPlanetSelector[];
    destinationSystems?: readonly MissionSystemSelector[];
    governments?: readonly GovernmentRelation[];
    random?: () => number;
}

function destinationSelectorIsSatisfiable(
    selector: number,
    planets: readonly MissionPlanetSelector[] | undefined,
    systems: readonly MissionSystemSelector[] | undefined,
    governments: readonly GovernmentRelation[] | undefined,
    initialPlanetId: string,
    initialSystemId: string,
): boolean {
    if (planets === undefined && systems === undefined) {
        // Callers that do not load the galaxy can still use availability
        // filtering. Fixed IDs and random selectors are resolved on accept.
        return true;
    }
    const resolution = resolveSelector(selector, {
        planets,
        systems,
        governments,
        initialPlanetId,
        initialSystemId,
        random: () => 0,
    });
    return resolution.wildcard || resolution.candidates.length > 0;
}

function destinationIsSatisfiable(
    mission: MissionData,
    input: MissionAvailabilityInput,
): boolean {
    return destinationSelectorIsSatisfiable(
        mission.travelStel,
        input.destinationPlanets,
        input.destinationSystems,
        input.governments,
        input.currentPlanet.id,
        input.currentSystem.id,
    ) && destinationSelectorIsSatisfiable(
        mission.returnStel,
        input.destinationPlanets,
        input.destinationSystems,
        input.governments,
        input.currentPlanet.id,
        input.currentSystem.id,
    );
}

function missionCargoTons(mission: MissionData): number {
    if (mission.cargoType < 0 || mission.cargoQty === -1) {
        return 0;
    }
    return Math.abs(mission.cargoQty);
}

function matchesAvailableShip(
    mission: MissionData,
    shipId: string | undefined,
): boolean {
    const selector = mission.availShipType;
    // Retail uses 127 as its legacy "any ship" sentinel.
    if (!shipId || selector <= 127) {
        return true;
    }
    if (selector < 1000) {
        return sameResourceId(shipId, novaResourceId(selector));
    }
    if (selector >= 1000 && selector < 2000) {
        return !sameResourceId(shipId, novaResourceId(selector - 1000));
    }
    // Inherent-government selectors need parsed ship government data and are
    // intentionally left to a later legal-record/ship metadata pass.
    return true;
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
 * This covers the data-driven AvailStel selector ranges, including
 * government relations and adjacent-system availability.
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
        .filter(mission =>
            matchesAvailableShip(mission, input.playerState.shipId))
        .filter(mission => {
            const planets = input.destinationPlanets
                ? [...input.destinationPlanets]
                : [];
            if (!planets.some(planet =>
                sameResourceId(planet.id, input.currentPlanet.id))) {
                planets.push(input.currentPlanet);
            }
            const context: StellarSelectorContext = {
                planets,
                systems: input.destinationSystems ?? [input.currentSystem],
                governments: input.governments,
                currentPlanetId: input.currentPlanet.id,
                currentSystemId: input.currentSystem.id,
            };
            return matchesStellarSelector(
                mission.availStel, input.currentPlanet, context, 'availability');
        })
        .filter(mission => {
            try {
                return evaluateAvailabilityBits(
                    mission, input.playerState, input.outfits);
            } catch (error) {
                console.warn(`Skipping mission ${mission.id} with invalid AvailBits`, error);
                return false;
            }
        })
        .filter(mission => mission.availRandom > 0
            && (mission.availRandom >= 100
                || clampRandom(random()) < mission.availRandom / 100))
        .filter(mission => {
            if ((mission.flags2 & 0x0001) === 0) {
                return true;
            }
            if (!input.playerState.holds
                || input.playerState.cargoCapacity === undefined) {
                return true;
            }
            const cargoState = input.playerState as Pick<
                PlayerState, 'cargoCapacity' | 'holds'>;
            return missionCargoTons(mission) <= getFreeSpace(cargoState);
        })
        .filter(mission => destinationIsSatisfiable(mission, input));
}

function evaluateAvailabilityBits(
    mission: MissionData,
    playerState: Pick<
        PlayerState,
        'missionBits' | 'gender' | 'exploredSystems'
    >,
    outfits?: OutfitsState,
): boolean {
    return evaluateTestExpression(mission.availBits, {
        ...ncbTestContext(playerState, outfits),
    });
}

/**
 * Backwards-compatible string resolver for callers from phase one. New code
 * should use the structured resolver in stellar_selector.ts.
 */
export function resolveStellarSelector(
    selector: number,
    options: {
        initialPlanetId: string;
        planets?: readonly MissionPlanetSelector[];
        systems?: readonly MissionSystemSelector[];
        governments?: readonly GovernmentRelation[];
        initialSystemId?: string;
        currentSystemId?: string;
        random?: () => number;
    },
): string | '*' | undefined {
    if (selector === -1) {
        return '*';
    }
    const resolution = resolveSelector(selector, {
        planets: options.planets,
        systems: options.systems,
        governments: options.governments,
        initialPlanetId: options.initialPlanetId,
        initialSystemId: options.initialSystemId ?? options.currentSystemId,
        random: options.random,
    });
    if (resolution.selected) {
        return resolution.selected;
    }
    if (selector >= 128 && selector <= 2175
        && options.planets === undefined) {
        return novaResourceId(selector);
    }
    return undefined;
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
        systems?: readonly MissionSystemSelector[];
        governments?: readonly GovernmentRelation[];
        random?: () => number;
    } = {},
): string | '*' | undefined {
    const selector = mission.returnStel === -1 && mission.dropOffMode === 0
        ? mission.travelStel
        : mission.returnStel;
    return resolveStellarSelector(selector, {
        initialPlanetId,
        systems: options.systems,
        governments: options.governments,
        ...options,
    });
}

