/**
 * Jump fuel.
 *
 * Retail stores fuel in units and spends 100 of them per hyperspace jump, so
 * a ship's `Fuel` field of 300 is three jumps. The pilot-facing wording is
 * whole jumps, which is why the status bar counts jumps rather than units.
 */

/** Units of fuel one hyperspace jump costs. */
export const FUEL_PER_JUMP = 100;

/** Retail's refusal message, from `STR#` 2002. */
export const INSUFFICIENT_FUEL_MESSAGE =
    'Insufficient energy for hyperspace jump.';

export interface FuelGauge {
    fuel: number;
    capacity: number;
}

export interface FuelJumpBlocks {
    /** Blocks the tank can hold, one per jump. */
    total: number;
    /** Whole jumps available. */
    full: number;
    /** Fraction of the next jump that is fuelled, 0 to 1. */
    partial: number;
}

/**
 * Split a tank into the blocks retail draws on the status bar.
 */
export function fuelJumpBlocks(gauge: FuelGauge): FuelJumpBlocks {
    const capacity = Math.max(0, gauge.capacity);
    const total = Math.floor(capacity / FUEL_PER_JUMP);
    const fuel = clampFuel(gauge.fuel, capacity);
    const full = Math.min(total, Math.floor(fuel / FUEL_PER_JUMP));
    const remainder = fuel - full * FUEL_PER_JUMP;
    return {
        total,
        full,
        partial: full >= total ? 0 : remainder / FUEL_PER_JUMP,
    };
}

export function jumpsFromFuel(fuel: number): number {
    if (!Number.isFinite(fuel) || fuel <= 0) {
        return 0;
    }
    return Math.floor(fuel / FUEL_PER_JUMP);
}

export function canJump(fuel: number): boolean {
    return fuel >= FUEL_PER_JUMP;
}

export function spendJumpFuel(fuel: number): number {
    return Math.max(0, fuel - FUEL_PER_JUMP);
}

/**
 * Fuel is capped by the ship's tank. A pilot who downgrades to a smaller
 * hull loses the fuel that no longer fits rather than keeping a phantom
 * reserve.
 */
export function clampFuel(fuel: number, capacity: number): number {
    const tank = Math.max(0, capacity);
    if (!Number.isFinite(fuel) || fuel <= 0) {
        return 0;
    }
    return Math.min(fuel, tank);
}

/**
 * Where a pilot can buy fuel.
 *
 * The Bible describes spöb flag 0x00000020 as "Stellar is uninhabited (no
 * traffic control or refuelling)", so every inhabited stellar sells it and a
 * bare rock does not.
 */
export function refuelsOnLanding(
    planet: { readonly inhabited?: boolean },
): boolean {
    return planet.inhabited !== false;
}

/**
 * What a recharge costs: 100 credits per jump, so 1 credit a unit.
 *
 * No retail resource carries this number and the Bible never states it, but
 * the retail landing screen charges 100 credits per jump. The
 * Auto-recharger buys the same recharge automatically on landing rather than
 * discounting it.
 */
export const FUEL_PRICE_PER_JUMP = 100;

/** A part-used jump is charged as a whole one, so the pilot leaves full. */
export function refuelCost(
    fuel: number,
    capacity: number,
    pricePerJump = FUEL_PRICE_PER_JUMP,
): number {
    const missing = Math.max(0, Math.max(0, capacity) - Math.max(0, fuel));
    if (missing === 0) {
        return 0;
    }
    return Math.ceil(missing / FUEL_PER_JUMP) * pricePerJump;
}

export interface RefuelResult {
    fuel: number;
    credits: number;
    /** Jumps actually bought, so a caller can report what happened. */
    purchased: number;
}

/** Buy as many whole jumps as the pilot's credits stretch to. */
export function buyFuel(
    fuel: number,
    capacity: number,
    credits: number,
    pricePerJump = FUEL_PRICE_PER_JUMP,
): RefuelResult {
    const tank = Math.max(0, capacity);
    const held = clampFuel(fuel, tank);
    const missing = tank - held;
    if (missing <= 0) {
        return { fuel: held, credits, purchased: 0 };
    }
    const wanted = Math.ceil(missing / FUEL_PER_JUMP);
    const affordable = pricePerJump <= 0
        ? wanted
        : Math.min(wanted, Math.floor(Math.max(0, credits) / pricePerJump));
    if (affordable <= 0) {
        return { fuel: held, credits, purchased: 0 };
    }
    return {
        fuel: clampFuel(held + affordable * FUEL_PER_JUMP, tank),
        credits: credits - affordable * pricePerJump,
        purchased: affordable,
    };
}
