import { PersData } from "novadatainterface/PersData";
import { ShipData } from "novadatainterface/ShipData";
import { evaluateTestExpression } from "./ncb";
import type { NcbTestContext } from "./ncb";

export const PersFlags = {
    holdsGrudge: 0x0001,
    escapePod: 0x0002,
    quoteGrudge: 0x0004,
    quoteLike: 0x0008,
    quoteAttack: 0x0010,
    quoteDisabled: 0x0020,
    linkSpecialShip: 0x0040,
    hailOnce: 0x0080,
    linkDeactivate: 0x0100,
    linkBoard: 0x0200,
    linkQuote: 0x0400,
    linkLeave: 0x0800,
    linkNoWimpy: 0x1000,
    linkNoBeefy: 0x2000,
    linkNoWarship: 0x4000,
    hailDisaster: 0x8000,
} as const;

export const PersFlags2 = {
    zeroFuel: 0x0001,
} as const;

export const PERS_SPAWN_CHANCE = 0.05;

export interface PersSystem {
    id: string | number;
    government?: number;
}

export interface PersGovernment {
    id?: string | number;
    index?: number;
    allies?: readonly (string | number)[];
    enemies?: readonly (string | number)[];
}

export interface PersState {
    alive?: boolean;
    grudge?: boolean;
    likesPlayer?: boolean;
    quoteShown?: boolean;
}

export interface PersEligibilityContext {
    systemId?: string | number;
    systemGovernment?: number;
    systems?: readonly PersSystem[];
    governments?: readonly PersGovernment[];
    alive?: ReadonlySet<string | number>;
    state?: PersState;
    evaluateActiveOn?: (expression: string) => boolean;
    ncbContext?: NcbTestContext;
}

export interface PersQuoteContext {
    grudge?: boolean;
    likesPlayer?: boolean;
    attacking?: boolean;
    disabled?: boolean;
    quoteShown?: boolean;
    linkMissionAvailable?: boolean;
    playerAiType?: number;
}

function numericId(value: string | number | undefined): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const match = /^(?:[^:]+:)?(-?\d+)$/.exec(value);
    return match ? Number(match[1]) : undefined;
}

function sameId(
    first: string | number | undefined,
    second: string | number | undefined,
): boolean {
    if (first === undefined || second === undefined) {
        return false;
    }
    if (first === second) {
        return true;
    }
    const firstNumber = numericId(first);
    const secondNumber = numericId(second);
    return firstNumber !== undefined
        && secondNumber !== undefined
        && firstNumber === secondNumber;
}

function governmentIndex(value: string | number | undefined): number | undefined {
    const number = numericId(value);
    if (number === undefined || number < 0) {
        return undefined;
    }
    return number >= 128 && number <= 383 ? number - 128 : number;
}

function governmentForIndex(
    index: number,
    context: PersEligibilityContext,
): PersGovernment | undefined {
    return (context.governments ?? []).find(government =>
        (government.index ?? governmentIndex(government.id)) === index);
}

function listedGovernmentIndex(
    values: readonly (string | number)[] | undefined,
): Set<number> {
    return new Set(
        (values ?? [])
            .map(governmentIndex)
            .filter((index): index is number => index !== undefined),
    );
}

function systemForContext(
    context: PersEligibilityContext,
): PersSystem | undefined {
    if (context.systemId === undefined) {
        return undefined;
    }
    return (context.systems ?? []).find(system =>
        sameId(system.id, context.systemId));
}

function systemGovernment(context: PersEligibilityContext): number | undefined {
    return context.systemGovernment ?? systemForContext(context)?.government;
}

function encodedGovernment(
    selector: number,
    base: number,
): number | undefined {
    if (selector < base || selector > base + 255) {
        return undefined;
    }
    return selector - base;
}

function linkSystemMatches(
    linkSyst: string | number,
    context: PersEligibilityContext,
): boolean {
    if (linkSyst === -1) {
        return true;
    }

    if (typeof linkSyst === "string") {
        return sameId(linkSyst, context.systemId);
    }

    if (linkSyst >= 128 && linkSyst <= 2175) {
        return sameId(linkSyst, context.systemId);
    }

    const actualGovernment = governmentIndex(systemGovernment(context));
    if (actualGovernment === undefined) {
        return false;
    }

    // 9999 is used by the selector family as the unindexed any-government
    // sentinel. Indexed government selectors begin at 10000.
    if (linkSyst === 9999) {
        return true;
    }

    const exactGovernment = encodedGovernment(linkSyst, 10000);
    if (exactGovernment !== undefined) {
        return actualGovernment === exactGovernment;
    }

    const allyGovernment = encodedGovernment(linkSyst, 15000);
    if (allyGovernment !== undefined) {
        const target = governmentForIndex(allyGovernment, context);
        return listedGovernmentIndex(target?.allies).has(actualGovernment);
    }

    const otherGovernment = encodedGovernment(linkSyst, 20000);
    if (otherGovernment !== undefined) {
        return actualGovernment !== otherGovernment;
    }

    const enemyGovernment = encodedGovernment(linkSyst, 25000);
    if (enemyGovernment !== undefined) {
        const target = governmentForIndex(enemyGovernment, context);
        return listedGovernmentIndex(target?.enemies).has(actualGovernment);
    }

    return false;
}

function persIsAlive(
    pers: PersData,
    context: PersEligibilityContext,
): boolean {
    if (context.state?.alive === false) {
        return false;
    }
    if (!context.alive) {
        return true;
    }
    return context.alive.has(pers.id)
        || [...context.alive].some(id => sameId(id, pers.id));
}

/**
 * Test the three gates used before Nova considers a përs for creation:
 * location, ActiveOn, and whether the individual is still alive.
 */
export function isPersEligible(
    pers: PersData,
    context: PersEligibilityContext,
): boolean {
    if (!persIsAlive(pers, context)
        || !linkSystemMatches(pers.linkSyst, context)) {
        return false;
    }
    if (!pers.activeOn) {
        return true;
    }
    if (context.evaluateActiveOn) {
        return context.evaluateActiveOn(pers.activeOn);
    }
    return context.ncbContext
        ? evaluateTestExpression(pers.activeOn, context.ncbContext)
        : false;
}

function clampedRandom(random: () => number): number {
    return Math.max(0, Math.min(0.999999999, random()));
}

/**
 * Select one eligible person using retail's independent five-percent roll.
 * Callers should invoke this once for each ambient ship creation opportunity.
 */
export function selectPers(
    people: readonly PersData[],
    context: PersEligibilityContext,
    random: () => number = Math.random,
): PersData | undefined {
    const eligible = people.filter(person => isPersEligible(person, context));
    if (eligible.length === 0 || clampedRandom(random) >= PERS_SPAWN_CHANCE) {
        return undefined;
    }
    return eligible[Math.floor(clampedRandom(random) * eligible.length)];
}

export function persHoldsGrudge(
    pers: Pick<PersData, "flags">,
    state: PersState,
): boolean {
    return Boolean(state.grudge)
        && (pers.flags & PersFlags.holdsGrudge) !== 0;
}

export function recordPersAttack(
    pers: Pick<PersData, "flags">,
    state: PersState = {},
): PersState {
    return (pers.flags & PersFlags.holdsGrudge) !== 0
        ? { ...state, grudge: true }
        : { ...state };
}

/**
 * Escape-pod persons are not permanently removed by a destruction event.
 * The Bible documents the escape-pod behavior but does not explicitly say
 * whether that preserves the person record; this matches retail's killable
 * listing, which excludes the escape-pod flag.
 */
export function recordPersDestruction(
    pers: Pick<PersData, "flags">,
    state: PersState = {},
): PersState {
    return (pers.flags & PersFlags.escapePod) !== 0
        ? { ...state }
        : { ...state, alive: false };
}

export function canOfferPersMission(
    pers: Pick<PersData, "linkMission" | "flags">,
    context: PersQuoteContext,
): boolean {
    if (!pers.linkMission || context.linkMissionAvailable === false) {
        return false;
    }
    if ((pers.flags & PersFlags.linkNoWimpy) !== 0
        && context.playerAiType === 1) {
        return false;
    }
    if ((pers.flags & PersFlags.linkNoBeefy) !== 0
        && context.playerAiType === 2) {
        return false;
    }
    if ((pers.flags & PersFlags.linkNoWarship) !== 0
        && context.playerAiType === 3) {
        return false;
    }
    return true;
}

export function shouldShowPersHailQuote(
    pers: Pick<PersData, "hailQuote" | "flags">,
    context: PersQuoteContext,
): boolean {
    if (pers.hailQuote < 0
        || context.quoteShown && (pers.flags & PersFlags.hailOnce) !== 0) {
        return false;
    }
    if ((pers.flags & PersFlags.quoteGrudge) !== 0 && !context.grudge) {
        return false;
    }
    if ((pers.flags & PersFlags.quoteLike) !== 0 && !context.likesPlayer) {
        return false;
    }
    if ((pers.flags & PersFlags.quoteAttack) !== 0 && !context.attacking) {
        return false;
    }
    if ((pers.flags & PersFlags.quoteDisabled) !== 0 && !context.disabled) {
        return false;
    }
    return (pers.flags & PersFlags.linkQuote) === 0
        || context.linkMissionAvailable === true;
}

export function recordPersQuoteShown(
    state: PersState = {},
): PersState {
    return { ...state, quoteShown: true };
}

export function resolvePersCommQuote(
    pers: Pick<PersData, "commQuote">,
): number | undefined {
    return pers.commQuote >= 0 ? pers.commQuote : undefined;
}

export function resolvePersHailQuote(
    pers: Pick<PersData, "hailQuote" | "flags">,
    context: PersQuoteContext,
): number | undefined {
    return shouldShowPersHailQuote(pers, context)
        ? pers.hailQuote : undefined;
}

export function persShipOverrides(pers: PersData) {
    return {
        name: pers.name,
        shipType: pers.shipType,
        government: pers.government,
        aiType: pers.aiType,
        aggress: pers.aggress,
        coward: pers.coward,
        shieldMultiplier: pers.shieldMod < 0
            ? undefined : pers.shieldMod / 100,
        invincible: pers.shieldMod < 0,
        zeroFuel: (pers.flags2 & PersFlags2.zeroFuel) !== 0,
        weaponTypes: pers.weaponTypes,
        weaponCounts: pers.weaponCounts,
        ammoLoads: pers.ammoLoads,
        colour: pers.color,
        shipSubtitle: pers.shipSubtitle,
    };
}

/**
 * Apply the person-owned parts of a ship to the stock hull data. Weapon
 * additions remain separate because the ECS stores installed weapons rather
 * than raw weapon IDs.
 */
export function applyPersShipData(
    ship: ShipData,
    pers: PersData,
): ShipData {
    const overrides = persShipOverrides(pers);
    return {
        ...ship,
        name: overrides.name,
        inherentAI: overrides.aiType,
        physics: {
            ...ship.physics,
            ...(overrides.shieldMultiplier === undefined
                ? {}
                : { shield: ship.physics.shield
                    * overrides.shieldMultiplier }),
        },
    };
}
