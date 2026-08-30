import {
    STANDARD_COMMODITIES,
    StandardCommodity,
} from 'novadatainterface/CommodityData';
import {
    getDefaultMissionData,
    MissionData,
} from 'novadatainterface/MissionData';
import { clampRandom } from '../common/random';

export type ProceduralMissionType = 'cargo' | 'rush' | 'passenger' | 'bounty';

const OUTLAW_NAMES = [
    "Vance 'Reaper' Stone",
    "Captain Silas Drake",
    "Kallum the Red",
    "Dread Corsair Vane",
    "Renegade Ace Hawke",
    "Syndicate Raider Jax",
    "Baron Von Kroll",
    "Black Nova Marauder",
];

const OUTLAW_SHIPS = [
    { id: 'nova:132', name: 'Pirate Viper' },
    { id: 'nova:133', name: 'Valkyrie' },
    { id: 'nova:134', name: 'Thunderbird' },
    { id: 'nova:141', name: 'Heavy Raider' },
    { id: 'nova:144', name: 'Marauder' },
];

export interface ProceduralSystem {
    id: string;
    links: readonly string[];
    planets?: readonly string[];
}

export interface ProceduralPlanet {
    id: string;
    name?: string;
    inhabited?: boolean;
    systemId?: string;
}

export interface ProceduralMissionOffer {
    mission: MissionData;
    destinationPlanetId: string;
    destinationSystemId: string;
    jumpDistance: number;
    type: ProceduralMissionType;
    available: boolean;
}

export interface ProceduralMissionInput {
    currentSystemId: string;
    currentPlanetId?: string;
    gameDate: number;
    systems: readonly ProceduralSystem[];
    planets: readonly ProceduralPlanet[];
    freeSpace?: number;
    seed?: string;
}

function normalizedId(id: string): string {
    return id.replace(/^.*:/, '');
}

function sameId(a: string, b: string): boolean {
    return a === b || normalizedId(a) === normalizedId(b);
}

function hashString(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

/**
 * Small deterministic PRNG used for mission boards. Board generation is
 * intentionally a pure function of stellar, pilot/date and sorted catalogs,
 * so reopening a board cannot reroll it.
 */
export function seededRandom(seed: string): () => number {
    let value = hashString(seed) || 0x6d2b79f5;
    return () => {
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function systemForId(
    systems: readonly ProceduralSystem[],
    id: string,
): ProceduralSystem | undefined {
    return systems.find(system => sameId(system.id, id));
}

/**
 * Return the shortest hyperjump distance from one system to every reachable
 * system. Links are treated as directed because that mirrors the resource
 * data; retail links are normally reciprocal.
 */
export function calculateJumpDistances(
    startSystemId: string,
    systems: readonly ProceduralSystem[],
): Map<string, number> {
    const distances = new Map<string, number>();
    const start = systemForId(systems, startSystemId);
    if (!start) {
        return distances;
    }

    const queue: ProceduralSystem[] = [start];
    distances.set(start.id, 0);
    while (queue.length > 0) {
        const current = queue.shift()!;
        const currentDistance = distances.get(current.id)!;
        for (const link of current.links) {
            const next = systemForId(systems, link);
            if (!next || distances.has(next.id)) {
                continue;
            }
            distances.set(next.id, currentDistance + 1);
            queue.push(next);
        }
    }
    return distances;
}

export function jumpDistanceBFS(
    startSystemId: string,
    destinationSystemId: string,
    systems: readonly ProceduralSystem[],
): number | undefined {
    const destination = systemForId(systems, destinationSystemId);
    if (!destination) {
        return undefined;
    }
    return calculateJumpDistances(startSystemId, systems).get(destination.id);
}

function planetSystemId(
    planet: ProceduralPlanet,
    systems: readonly ProceduralSystem[],
): string | undefined {
    if (planet.systemId) {
        return systemForId(systems, planet.systemId)?.id;
    }
    return systems.find(system =>
        system.planets?.some(planetId => sameId(planetId, planet.id)))?.id;
}

function destinationCandidates(input: ProceduralMissionInput) {
    const distances = calculateJumpDistances(input.currentSystemId, input.systems);
    const candidates: Array<{
        planet: ProceduralPlanet;
        systemId: string;
        distance: number;
    }> = [];
    for (const planet of input.planets) {
        if (planet.inhabited === false
            || (input.currentPlanetId && sameId(planet.id, input.currentPlanetId))) {
            continue;
        }
        const systemId = planetSystemId(planet, input.systems);
        if (!systemId) {
            continue;
        }
        const distance = distances.get(systemId);
        if (distance !== undefined && distance >= 1 && distance <= 4) {
            candidates.push({ planet, systemId, distance });
        }
    }
    return candidates.sort((a, b) =>
        a.planet.id.localeCompare(b.planet.id));
}

function randomCommodity(random: () => number): StandardCommodity {
    const index = Math.floor(
        clampRandom(random()) * STANDARD_COMMODITIES.length);
    return STANDARD_COMMODITIES[index]!;
}

/**
 * Generate the engine-created Mission Computer board.
 *
 * The EVN Bible documents the mission computer as AvailLoc 0 and documents
 * random mission destinations, but does not specify this generator's exact
 * templates. This implementation follows the documented community template
 * categories (passenger ferry, cargo delivery, and rush delivery) from
 * https://evnova.miraheze.org/wiki/Nova:Standard_Deliveries, with the
 * requested Wave 4 distance/tonnage scaling. The stable 6-12 offer board and
 * 1-4 jump range are approximations so a future data-driven generator can
 * replace them.
 */
export function generateProceduralMissions(
    input: ProceduralMissionInput,
): ProceduralMissionOffer[] {
    const seed = input.seed
        ?? `${input.currentSystemId}:${input.currentPlanetId ?? ''}:${input.gameDate}`;
    const random = seededRandom(seed);
    const candidates = destinationCandidates(input);
    if (candidates.length === 0) {
        return [];
    }

    const count = 6 + Math.floor(clampRandom(random()) * 7);
    const freeSpace = Math.max(0, Math.floor(input.freeSpace ?? 0));
    const boardSeed = hashString(seed).toString(16);
    const offers: ProceduralMissionOffer[] = [];

    for (let index = 0; index < count; index++) {
        const candidate = candidates[
            Math.floor(clampRandom(random()) * candidates.length)]!;
        const kindRoll = clampRandom(random());
        if (kindRoll < 0.15) {
            const outlaw = OUTLAW_NAMES[Math.floor(clampRandom(random()) * OUTLAW_NAMES.length)];
            const outlawShip = OUTLAW_SHIPS[Math.floor(clampRandom(random()) * OUTLAW_SHIPS.length)];
            const pay = Math.max(15_000, Math.round(
                20_000 + candidate.distance * 12_000 + clampRandom(random()) * 25_000));
            const title = `BOUNTY: ${outlaw} (${outlawShip.name})`;
            const briefText = `A bounty of ${pay} credits has been posted for the destruction of ${outlaw}, piloting a ${outlawShip.name} last sighted in the ${candidate.systemId} system. Terminate the target to collect.`;
            const deadline = Math.max(6, candidate.distance * 5);
            const mission: MissionData = {
                ...getDefaultMissionData(),
                id: `proc:${boardSeed}:${index}`,
                prefix: 'proc',
                name: title,
                availStel: -1,
                availLoc: 0,
                availRandom: 100,
                travelStel: -1,
                returnStel: -1,
                destination: -1,
                returnDestination: -1,
                payVal: pay,
                pay,
                briefText,
                quickBrief: `Bounty: ${outlaw} (${pay} cr)`,
                offerText: briefText,
                timeLimit: deadline,
                shipGoal: 1,
                shipCount: 1,
                shipSyst: parseInt(candidate.systemId.replace(/^.*:/, ''), 10) || -6,
                shipId: outlawShip.id,
                canAbort: true,
                displayWeight: 1,
            };
            offers.push({
                mission,
                destinationPlanetId: candidate.planet.id,
                destinationSystemId: candidate.systemId,
                jumpDistance: candidate.distance,
                type: 'bounty',
                available: true,
            });
            continue;
        }
        const type: ProceduralMissionType = kindRoll < 0.35
            ? 'passenger'
            : kindRoll < 0.65 ? 'rush' : 'cargo';
        const commodity = randomCommodity(random);
        const normalMaximum = type === 'passenger'
            ? Math.min(4, Math.max(1, freeSpace))
            : Math.max(1, freeSpace);
        const oversized = index % 5 === 0 || clampRandom(random()) < 0.15;
        const tons = oversized
            ? freeSpace + 1
                + Math.floor(clampRandom(random())
                    * Math.max(1, Math.floor(freeSpace * 0.5) + 2))
            : 1 + Math.floor(clampRandom(random()) * normalMaximum);
        const rate = 100 + Math.floor(clampRandom(random()) * 151);
        const rushMultiplier = type === 'rush'
            ? 1.5 + clampRandom(random()) * 0.5
            : 1;
        const pay = Math.max(1, Math.round(
            rate * tons * candidate.distance * rushMultiplier));
        const destinationName = candidate.planet.name ?? candidate.planet.id;
        const title = type === 'passenger'
            ? `Ferry ${tons} passengers to ${destinationName}`
            : type === 'rush'
                ? `Rush: ${tons} tons of ${commodity} to ${destinationName}`
                : `Take ${tons} tons of ${commodity} to ${destinationName}`;
        const deadline = type === 'rush'
            ? Math.max(2, candidate.distance * 2)
            : type === 'passenger'
                ? Math.max(3, candidate.distance * 3)
                : Math.max(3, candidate.distance * 4);
        const mission: MissionData = {
            ...getDefaultMissionData(),
            id: `proc:${boardSeed}:${index}`,
            prefix: 'proc',
            name: title,
            availStel: -1,
            availLoc: 0,
            availRandom: 100,
            travelStel: -1,
            returnStel: -1,
            destination: -1,
            returnDestination: -1,
            cargoType: STANDARD_COMMODITIES.indexOf(commodity),
            cargoQty: tons,
            cargo: type === 'passenger' ? 'passengers' : commodity,
            pickupMode: 0,
            dropOffMode: 0,
            payVal: pay,
            pay,
            briefText: `${title}. Payment: ${pay} credits.`,
            quickBrief: title,
            offerText: title,
            timeLimit: deadline,
            canAbort: true,
            displayWeight: 1,
        };
        offers.push({
            mission,
            destinationPlanetId: candidate.planet.id,
            destinationSystemId: candidate.systemId,
            jumpDistance: candidate.distance,
            type,
            available: tons <= freeSpace,
        });
    }
    return offers;
}

