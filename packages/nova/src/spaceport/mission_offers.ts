import { dateFromDayNumber, formatDate } from '../nova_plugin/calendar.js';
import {
    cargoName,
    makeMissionOffer,
    MissionOffer,
    missionMatchesLocation,
} from '../nova_plugin/mission_logic.js';
import { ActiveMission } from '../nova_plugin/player_state_plugin.js';
import { MissionSession } from './mission_session.js';
import { MissionUniverse } from './mission_universe.js';

/**
 * Offer plumbing shared by the mission BBS and the bar: rolling the
 * day's offers and building the wildcard substitution table for
 * expandMissionText.
 */

/**
 * Rolls availability once (per board opening / bar entry) and freezes
 * the offers, sorted by display weight. The AvailRandom percentage
 * roll is player-local UI randomness (like the outfitter's R(a b)
 * rolls), so plain Math.random is fine — only accepted-mission state
 * ever reaches the simulation.
 */
export function rollOffers(session: MissionSession,
    universe: MissionUniverse, location: number): MissionOffer[] {
    const ctx = session.machinery.offerContext();
    const offers: MissionOffer[] = [];
    for (const mission of universe.missions) {
        if (!missionMatchesLocation(mission, location, ctx)) {
            continue;
        }
        if (mission.availRandom < 100
            && Math.random() * 100 >= mission.availRandom) {
            continue;
        }
        const offer = makeMissionOffer(mission, ctx);
        if (offer) {
            offers.push(offer);
        }
    }
    offers.sort((a, b) => b.data.dispWeight - a.data.dispWeight);
    return offers;
}

/**
 * The <DST>/<RET>/... substitution table for one offer. `currentDay`
 * is the player's day number, used only to derive an offer's deadline
 * when the (not-yet-active) offer has a time limit; an already-active
 * mission carries its own resolved deadlineDay, so this dialog works in
 * flight (no MissionSession) as well as docked.
 */
export function offerSubstitutions(universe: MissionUniverse,
    currentDay: number, offer: MissionOffer,
    active?: ActiveMission) {
    const travel = active?.travelPlanet ?? offer.travelPlanet;
    const ret = active?.returnPlanet ?? offer.returnPlanet;
    const deadlineDay = active?.deadlineDay
        ?? (offer.data.timeLimit > 0
            ? currentDay + offer.data.timeLimit : null);
    return {
        destinationStellar: universe.planetName(travel ?? ret),
        destinationSystem: universe.systemNameOfPlanet(travel ?? ret),
        returnStellar: universe.planetName(ret),
        returnSystem: universe.systemNameOfPlanet(ret),
        cargoType: offer.cargoType >= 0
            ? cargoName(offer.cargoType, universe.cargoNames) : undefined,
        cargoQty: offer.cargoQty > 0 ? offer.cargoQty : undefined,
        deadline: deadlineDay !== null
            ? formatDate(dateFromDayNumber(deadlineDay)) : undefined,
        payment: offer.data.payVal > 0 ? offer.data.payVal : undefined,
        // <SN>: only an ACCEPTED mission has a special ship name (the
        // pick happens at accept — EVN Bible). A bare offer leaves it
        // undefined, which expandMissionText renders as its generic
        // fallback.
        specialShipName: active?.shipName,
    };
}

/** A pseudo-offer view of an already-active mission, for display. */
export function activeAsOffer(universe: MissionUniverse,
    active: ActiveMission): MissionOffer | undefined {
    const mission = universe.getMission(active.id);
    if (!mission) {
        return undefined;
    }
    return {
        data: mission,
        travelPlanet: active.travelPlanet,
        returnPlanet: active.returnPlanet,
        cargoType: active.cargoType,
        cargoQty: active.cargoQty,
        acceptable: true,
    };
}
