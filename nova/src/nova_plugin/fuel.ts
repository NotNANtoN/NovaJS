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
 * Whether landing here fills the tank.
 *
 * Refuelling is a property of the place, not a purchase. The Bible describes
 * spöb flag 0x00000020 as "Stellar is uninhabited (no traffic control or
 * refuelling)", and names no price for fuel anywhere, so every inhabited
 * stellar a pilot can land on tops them up for free.
 */
export function refuelsOnLanding(
    planet: { readonly inhabited?: boolean },
): boolean {
    return planet.inhabited !== false;
}

/** Fill the tank on landing, leaving a full pilot untouched. */
export function refuelOnLanding(
    fuel: number,
    capacity: number,
    planet: { readonly inhabited?: boolean },
): number {
    const held = clampFuel(fuel, capacity);
    return refuelsOnLanding(planet) ? Math.max(0, capacity) : held;
}
