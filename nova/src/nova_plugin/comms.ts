/**
 * Ship-to-ship communication.
 *
 * Every line a hailed ship speaks comes from `STR#` 3000, which retail lays
 * out as consecutive blocks of five interchangeable phrasings. Naming those
 * blocks here keeps the engine speaking the game's own words instead of
 * inventing dialogue, and keeps the indices in one place if a plug-in
 * replaces the list.
 */

import { GovernmentRelation } from './govt_relations';
import { FUEL_PER_JUMP } from './fuel';

/** The `STR#` list holding every hail response. */
export const COMMS_STRING_LIST = 'nova:3000';
/** Farewells, and the prefix list that names the ship being hailed. */
export const COMMS_CHANNEL_STRING_LIST = 'nova:3002';

/** How many interchangeable phrasings retail stores per response. */
export const COMMS_BLOCK_SIZE = 5;

/**
 * The first index of each block of five in `STR#` 3000. The names describe
 * what the block means rather than quoting it, since a plug-in may reword the
 * lines without changing their purpose.
 */
export const CommsBlock = {
    channelOpen: 0,
    noResponse: 5,
    promptNeutral: 10,
    promptHostile: 15,
    promptFriendly: 20,
    promptRespectful: 25,
    promptAllied: 30,
    promptWelcome: 35,
    promptGlad: 40,
    greetingWarm: 45,
    greetingIndifferent: 50,
    greetingHostile: 55,
    cannotAfford: 60,
    wastingMyTime: 65,
    notInTrouble: 70,
    willHelp: 75,
    tooBusy: 80,
    ratherNot: 85,
    payMeFirst: 90,
    inYourDreams: 95,
    pleasureDoingBusiness: 100,
    insulted: 105,
    cannotHelp: 110,
    goodMood: 115,
    badMood: 120,
    cannotDoThat: 125,
    confused: 130,
    leaveYouAlone: 135,
    helpForPay: 140,
    onMyWay: 145,
    dieCheapskate: 150,
    mockingRefusal: 155,
    becauseILikeYou: 160,
    cannotAffordDemand: 165,
    payingExtra: 170,
    takeItAndGo: 175,
    holdOnComing: 180,
    farewell: 185,
} as const;

export type CommsBlockName = keyof typeof CommsBlock;

/**
 * Pick one of a block's five phrasings. Callers pass a random sample so the
 * choice stays testable.
 */
export function commsLineIndex(
    block: CommsBlockName,
    sample = Math.random(),
): number {
    const clamped = Math.min(0.999999, Math.max(0, sample));
    return CommsBlock[block] + Math.floor(clamped * COMMS_BLOCK_SIZE);
}

/**
 * Keep a ship's mood stable between the browser preview and the authoritative
 * request without allowing the browser to choose any server-side condition.
 */
export function assistanceGenerosity(
    pilotUuid: string,
    helperUuid: string,
): number {
    let hash = 2166136261;
    for (const character of `${pilotUuid}:${helperUuid}`) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * How a ship answers being hailed at all. Retail escalates the warmth of the
 * greeting with the pilot's standing, and a ship already fighting the pilot
 * sneers instead.
 */
export function hailPromptBlock(options: {
    relation: GovernmentRelation,
    hostile: boolean,
    /** The pilot's record with this ship's government. */
    record: number,
}): CommsBlockName {
    if (options.hostile) {
        return 'promptHostile';
    }
    if (options.relation === 'enemy') {
        return 'promptHostile';
    }
    if (options.relation === 'ally') {
        return options.record > 0 ? 'promptWelcome' : 'promptAllied';
    }
    if (options.record > 0) {
        return 'promptRespectful';
    }
    return 'promptFriendly';
}

/**
 * How a government's ships regard the pilot when hailed.
 *
 * The pilot flies under no flag, so this cannot be a government-to-government
 * comparison. It rests on the pilot's legal record with that government, the
 * government's tolerance for crime, and whether its ships are shooting at the
 * pilot right now.
 */
export function hailRelation(options: {
    /** The pilot's record with this government. */
    record: number,
    /** How much crime this government forgives, from its gövt resource. */
    crimeTolerance: number,
    /** True when this ship is presently fighting the pilot. */
    hostile: boolean,
    /** True when the government attacks the pilot regardless of record. */
    alwaysHostile?: boolean,
}): GovernmentRelation {
    if (options.hostile || options.alwaysHostile) {
        return 'enemy';
    }
    if (options.record < -Math.max(0, options.crimeTolerance)) {
        return 'enemy';
    }
    return options.record > 0 ? 'ally' : 'neutral';
}

export type AssistanceOutcome =
    /** The pilot has no problem worth solving. */
    | 'notInTrouble'
    /** Fuel is on its way. */
    | 'granted'
    /** Help, but only for credits. */
    | 'wantsPayment'
    /** No help from this ship, ever. */
    | 'refused'
    /** Hailing an enemy for help earns mockery. */
    | 'mocked';

export interface AssistanceDecision {
    outcome: AssistanceOutcome;
    block: CommsBlockName;
    /** Credits demanded, when the outcome is `wantsPayment`. */
    price: number;
}

/** What a rescue costs when the helper wants paying. */
export const ASSISTANCE_PRICE = 500;

export interface AssistanceRequest {
    relation: GovernmentRelation;
    hostile: boolean;
    /** The pilot's record with this ship's government. */
    record: number;
    /** Fuel in the pilot's tank, in retail units. */
    fuel: number;
    /** The pilot's tank size; zero means the hull cannot hold fuel. */
    fuelCapacity: number;
    /** A disabled pilot needs hull repair even when there is fuel to jump. */
    disabled?: boolean;
    /**
     * gövt Flags2 0x0010: "Ships of this govt will always repair or refuel
     * the player for free."
     */
    roadsideAssistance?: boolean;
    /** Whether this ship is one of the pilot's own escorts. */
    isEscort?: boolean;
    /** A sample in [0,1) deciding whether a neutral ship is feeling generous. */
    generosity?: number;
}

/**
 * Decide how a ship answers a request for assistance.
 *
 * Retail's rule of thumb, which this follows: a pilot who is not actually
 * stuck is told so, enemies mock the request, allies and well-regarded pilots
 * are helped for free, and an indifferent stranger wants paying.
 */
export function assistanceDecision(
    request: AssistanceRequest,
): AssistanceDecision {
    const stranded = Boolean(request.disabled)
        || request.fuelCapacity > 0 && request.fuel < FUEL_PER_JUMP;

    if (!stranded) {
        return { outcome: 'notInTrouble', block: 'notInTrouble', price: 0 };
    }
    if (request.roadsideAssistance) {
        return { outcome: 'granted', block: 'willHelp', price: 0 };
    }
    if (request.hostile || request.relation === 'enemy') {
        return { outcome: 'mocked', block: 'inYourDreams', price: 0 };
    }
    // An escort answers its captain, but has nothing of its own to give.
    if (request.isEscort) {
        return { outcome: 'refused', block: 'cannotHelp', price: 0 };
    }
    if (request.relation === 'ally') {
        return { outcome: 'granted', block: 'willHelp', price: 0 };
    }
    if (request.record > 0) {
        // A pilot with a good name gets helped as a favour.
        return { outcome: 'granted', block: 'becauseILikeYou', price: 0 };
    }
    const generosity = request.generosity ?? Math.random();
    if (generosity < 0.25) {
        return { outcome: 'granted', block: 'willHelp', price: 0 };
    }
    if (generosity < 0.75) {
        return {
            outcome: 'wantsPayment',
            block: 'helpForPay',
            price: ASSISTANCE_PRICE,
        };
    }
    return { outcome: 'refused', block: 'tooBusy', price: 0 };
}

export interface AssistancePayment {
    /** True when the pilot could pay what was asked. */
    paid: boolean;
    credits: number;
    block: CommsBlockName;
}

/** Try to pay for a rescue that was offered for credits. */
export function payForAssistance(
    credits: number,
    price: number,
): AssistancePayment {
    if (credits < price) {
        return { paid: false, credits, block: 'cannotAfford' };
    }
    return { paid: true, credits: credits - price, block: 'onMyWay' };
}

/**
 * Fuel handed over by a rescuer: exactly enough to jump out, which is what
 * makes the rescue worth asking for without making tanks irrelevant.
 */
export const ASSISTANCE_FUEL = FUEL_PER_JUMP;

export function receiveAssistanceFuel(
    fuel: number,
    capacity: number,
): number {
    return Math.min(Math.max(0, capacity), Math.max(0, fuel) + ASSISTANCE_FUEL);
}

/** Roadside assistance repairs a disabled ship completely so it can recover. */
export function receiveAssistanceRepair(maxArmor: number): number {
    return Math.max(0, maxArmor);
}
