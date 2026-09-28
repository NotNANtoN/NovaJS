import { CharData } from 'novadatainterface/CharData';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { GovtData } from 'novadatainterface/GovtData';
import { resourceId } from '../common/resource_id';
import { relation } from './govt_relations';
import { recordFor } from './legal_record';
import { executeSetOperations, parseSetExpression } from './ncb';
import { createNcbHandlers } from './ncb_handlers';
import {
    createInitialPlayerState,
    PlayerState,
    setCargoCapacity,
    START_DATE_MS,
} from './player_state';

const DAY_MS = 24 * 60 * 60 * 1000;
/** EV Nova Bible, chär/StartSystem: "If all are -1, system 128 is used." */
const DEFAULT_START_SYSTEM = 128;
/** chär Flags 0x0001: "This is the default character type." */
const DEFAULT_CHAR_FLAG = 0x0001;

export interface StartingPlayerStateOptions {
    readonly logger?: (message: string) => void;
}

async function loadChar(gameData: GameDataInterface): Promise<CharData | undefined> {
    const gettable = gameData.data.Char;
    const ids = (await gameData.ids).Char ?? [];
    if (!gettable || ids.length === 0) {
        return undefined;
    }
    const chars: CharData[] = [];
    for (const id of ids) {
        try {
            chars.push(await gettable.get(id));
        } catch {
            // An unreadable template cannot be chosen.
        }
    }
    const numeric = (char: CharData) =>
        Number(/(-?\d+)$/.exec(char.id)?.[1] ?? Number.MAX_SAFE_INTEGER);
    const defaults = chars.filter(char => ((char.flags ?? 0) & DEFAULT_CHAR_FLAG) !== 0)
        .sort((a, b) => numeric(a) - numeric(b));
    return defaults[0] ?? chars[0];
}

/**
 * Days from the engine epoch (START_DATE_MS, 18 Oct 1177) to the chär start
 * date, or undefined when the date is invalid.
 */
export function charStartGameDate(char: Pick<CharData, 'startDay' | 'startMonth' | 'startYear'>): number | undefined {
    const { startDay, startMonth, startYear } = char;
    if (![startDay, startMonth, startYear].every(Number.isInteger)
        || startMonth < 1 || startMonth > 12 || startDay < 1 || startDay > 31) {
        return undefined;
    }
    return Math.round((Date.UTC(startYear, startMonth - 1, startDay) - START_DATE_MS) / DAY_MS);
}

async function firstLandablePlanet(gameData: GameDataInterface,
    planets: readonly string[]): Promise<string | undefined> {
    let fallback: string | undefined;
    for (const id of planets) {
        try {
            const planet = await gameData.data.Planet.get(id);
            if (planet.canLand === false) continue;
            if (planet.inhabited !== false) return planet.id;
            fallback ??= planet.id;
        } catch {
            // Skip stellars that fail to load.
        }
    }
    return fallback;
}

async function startingLegalRecords(gameData: GameDataInterface, char: CharData,
    logger: (message: string) => void): Promise<Record<string, number>> {
    const records: Record<string, number> = {};
    const entries = char.governments
        .map((govt, index) => [govt, char.status[index] ?? 0] as const)
        .filter(([govt, status]) => govt >= 128 && status !== 0);
    if (entries.length === 0 || !gameData.data.Govt) {
        return records;
    }
    const governments = new Map<string, GovtData>();
    for (const id of (await gameData.ids).Govt ?? []) {
        try {
            governments.set(id, await gameData.data.Govt.get(id));
        } catch {
            // A government that fails to load cannot hold a record.
        }
    }
    for (const [govtNumber, status] of entries) {
        const id = resourceId(govtNumber);
        const govt = governments.get(id);
        if (!govt) {
            logger(`chär ${char.id}: unknown government ${govtNumber}`);
            continue;
        }
        // EV Nova Bible, chär/Status: the initial legal status "with this
        // govt and its allies"; its enemies see the opposite.
        for (const [otherId, other] of governments) {
            const kind = otherId === id ? 'ally' : relation(govt, other);
            const delta = kind === 'ally' ? status : kind === 'enemy' ? -status : 0;
            if (delta !== 0) {
                records[otherId] = recordFor(records, otherId, other) + delta;
            }
        }
    }
    return records;
}

/**
 * A new pilot built from the default chär resource (EV Nova Bible, chär):
 * starting cash, ship, one of up to four starting systems, legal status,
 * kills, date and OnStart. Falls back to createInitialPlayerState when the
 * data has no usable chär.
 */
export async function createStartingPlayerState(
    gameData: GameDataInterface,
    random: () => number = Math.random,
    options: StartingPlayerStateOptions = {},
): Promise<PlayerState> {
    const logger = options.logger ?? (message => console.warn(`[NEW PILOT] ${message}`));
    const state = createInitialPlayerState();
    const char = await loadChar(gameData).catch(() => undefined);
    if (!char) {
        return state;
    }
    const ids = await gameData.ids;

    if (Number.isFinite(char.cash) && char.cash >= 0) {
        state.credits = Math.floor(char.cash);
    }
    const shipId = resourceId(char.shipType);
    if (ids.Ship.includes(shipId)) {
        state.shipId = shipId;
    } else {
        logger(`chär ${char.id}: unknown ship ${char.shipType}; keeping ${state.shipId}`);
    }
    try {
        const ship = await gameData.data.Ship.get(state.shipId);
        setCargoCapacity(state, ship.cargoCapacity);
        if (Number.isFinite(ship.fuelCapacity) && ship.fuelCapacity >= 0) {
            state.fuel = ship.fuelCapacity;
        }
    } catch {
        logger(`chär ${char.id}: could not load ship ${state.shipId}`);
    }

    const candidates = char.systems.filter(system => system >= 0);
    const systems = (candidates.length > 0 ? candidates : [DEFAULT_START_SYSTEM])
        .map(resourceId)
        .filter(system => ids.System.includes(system));
    if (systems.length > 0) {
        const pick = Math.min(systems.length - 1,
            Math.max(0, Math.floor(random() * systems.length)));
        const systemId = systems[pick];
        state.currentSystem = systemId;
        state.lastLandedSystem = systemId;
        try {
            const system = await gameData.data.System.get(systemId);
            const planet = await firstLandablePlanet(gameData, system.planets);
            if (planet) {
                state.lastLandedPlanet = planet;
            } else {
                logger(`chär ${char.id}: system ${systemId} has no landable stellar`);
            }
        } catch {
            logger(`chär ${char.id}: could not load system ${systemId}`);
        }
    } else {
        logger(`chär ${char.id}: no known starting system; keeping ${state.currentSystem}`);
    }

    state.legalRecords = await startingLegalRecords(gameData, char, logger);
    if (Number.isInteger(char.kills) && char.kills > 0) {
        state.kills = char.kills;
    }

    const gameDate = charStartGameDate(char);
    // gameDate counts days from 18 Oct 1177 and may be negative: retail's
    // default chär starts on 23 Jun 1177.
    if (gameDate !== undefined) {
        state.gameDate = gameDate;
        state.cronDate = gameDate - 1;
    }

    if (char.onStart?.trim()) {
        try {
            executeSetOperations(parseSetExpression(char.onStart, { logger }),
                state.missionBits, {
                    handlers: createNcbHandlers({ state, logger }),
                    random,
                    logger,
                });
        } catch (error) {
            logger(`chär ${char.id}: could not run OnStart '${char.onStart}': ${error}`);
        }
    }
    return state;
}
