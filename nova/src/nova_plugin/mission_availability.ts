import { GovtData } from 'novadatainterface/GovtData';
import { MissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import { getFreeSpace } from './player_state';
import type { PlayerState } from './player_state';
import { evaluateTestExpression } from './ncb';
import { ncbTestContext } from './ncb_runtime';
import type { OutfitsState } from './outfit_plugin';
import { clampRandom } from '../common/random';
import { combatRatingIndex, recordFor } from './legal_record';
import {
    GovernmentRelation,
    governmentIndex,
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
        & Partial<Pick<PlayerState,
            'cargoCapacity' | 'holds' | 'shipId' | 'legalRecords' | 'kills'>>;
    outfits?: OutfitsState;
    /** Inherent government of the ship the pilot is flying, when known. */
    playerShipGovt?: number;
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

/** Bible AvailRecord sentinels for planet domination, which we do not model. */
const DOMINATED_THIS_STELLAR = -32000;
const DOMINATED_ANY_STELLAR = -32001;

function controllingGovernment(
    planet: MissionPlanetSelector,
    system: MissionSystemSelector,
): number {
    if (planet.government !== undefined && planet.government >= 128) {
        return planet.government;
    }
    if (system.government !== undefined && system.government >= 128) {
        return system.government;
    }
    // Independent systems use government 128's record, per Appendix II.
    return 128;
}

function govtForId(
    governments: readonly GovernmentRelation[] | undefined,
    governmentId: string,
): Pick<GovtData, 'initialRecord'> | undefined {
    if (!governments) {
        return undefined;
    }
    for (const govt of governments) {
        if (govt.id !== undefined
            && sameResourceId(String(govt.id), governmentId)) {
            return govt as Pick<GovtData, 'initialRecord'>;
        }
        if (govt.index !== undefined
            && governmentIndex(governmentId) === govt.index) {
            return govt as Pick<GovtData, 'initialRecord'>;
        }
    }
    return undefined;
}

function storedRecord(
    records: PlayerState['legalRecords'] | undefined,
    governmentId: string,
    govt?: Pick<GovtData, 'initialRecord'>,
): number {
    if (records) {
        const exact = records[governmentId];
        if (exact !== undefined) {
            return exact;
        }
        for (const [key, value] of Object.entries(records)) {
            if (sameResourceId(key, governmentId)) {
                return value;
            }
        }
    }
    return recordFor(records, governmentId, govt);
}

/**
 * EV Nova Bible, mïsn/AvailRecord: 0 is ignored, a positive value is a
 * minimum standing, a negative value is a maximum (more criminal) standing.
 * Dominated-stellar sentinels stay closed until domination exists.
 */
function matchesAvailRecord(
    mission: MissionData,
    input: MissionAvailabilityInput,
): boolean {
    const required = mission.availRecord;
    if (required === 0) {
        return true;
    }
    if (required === DOMINATED_THIS_STELLAR
        || required === DOMINATED_ANY_STELLAR) {
        return false;
    }
    const governmentId = novaResourceId(
        controllingGovernment(input.currentPlanet, input.currentSystem));
    const record = storedRecord(
        input.playerState.legalRecords,
        governmentId,
        govtForId(input.governments, governmentId));
    return required > 0 ? record >= required : record <= required;
}

/**
 * EV Nova Bible, mïsn/AvailRating: -1 is ignored. Small values are STR# 138
 * ladder indexes; values at or above 100 are the Appendix I kill thresholds.
 */
function matchesAvailRating(mission: MissionData, kills: number | undefined) {
    const required = mission.availRating;
    if (required < 0) {
        return true;
    }
    const killCount = kills ?? 0;
    if (required >= 100) {
        return killCount >= required;
    }
    return combatRatingIndex(killCount) >= required;
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
    playerShipGovt?: number,
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
    if (selector >= 2128 && selector <= 2383) {
        if (playerShipGovt === undefined || playerShipGovt < 128) {
            return true;
        }
        return sameResourceId(
            novaResourceId(playerShipGovt),
            novaResourceId(selector - 2000));
    }
    if (selector >= 3128 && selector <= 3383) {
        if (playerShipGovt === undefined || playerShipGovt < 128) {
            return true;
        }
        return !sameResourceId(
            novaResourceId(playerShipGovt),
            novaResourceId(selector - 3000));
    }
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
            matchesAvailableShip(
                mission, input.playerState.shipId, input.playerShipGovt))
        .filter(mission => matchesAvailRecord(mission, input))
        .filter(mission =>
            matchesAvailRating(mission, input.playerState.kills))
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
 * Drop-off missions complete at TravelStel. ReturnStel is only the
 * completion point when the mission is not a travel drop-off and a return
 * stellar is actually set.
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
    const selector = mission.returnStel === -1 || mission.dropOffMode === 0
        ? mission.travelStel
        : mission.returnStel;
    return resolveStellarSelector(selector, {
        initialPlanetId,
        systems: options.systems,
        governments: options.governments,
        ...options,
    });
}

