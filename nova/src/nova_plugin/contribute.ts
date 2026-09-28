/**
 * EV Nova Contribute / Require flags.
 *
 * The Bible stores both as two 32-bit fields forming one 64-bit flag. Here a
 * value is always `[high, low]`, in resource field order. The player's
 * Contribute is the OR of the current ship, every outfit held, every active
 * ränk and every active crön. An item is available when each 1 bit of its
 * Require is present in that Contribute.
 */
export type Bits64 = readonly [number, number];

export const NO_BITS: Bits64 = [0, 0];

export function toBits64(value: readonly number[] | undefined | null): Bits64 {
    return [(value?.[0] ?? 0) >>> 0, (value?.[1] ?? 0) >>> 0];
}

export function orBits(...values: readonly (readonly number[] | undefined)[]): Bits64 {
    let high = 0;
    let low = 0;
    for (const value of values) {
        const [h, l] = toBits64(value);
        high = (high | h) >>> 0;
        low = (low | l) >>> 0;
    }
    return [high, low];
}

/** Every Require bit is present in Contribute. An all-zero Require passes. */
export function meetsRequire(
    require: readonly number[] | undefined | null,
    contribute: readonly number[] | undefined | null,
): boolean {
    const [rh, rl] = toBits64(require);
    const [ch, cl] = toBits64(contribute);
    return ((rh & ch) >>> 0) === rh && ((rl & cl) >>> 0) === rl;
}

export interface ContributeSources {
    ship?: { contribute?: readonly number[] } | undefined;
    /** Outfit data with the count held; a count of zero contributes nothing. */
    outfits?: Iterable<readonly [{ contribute?: readonly number[] } | undefined, number]>;
    ranks?: Iterable<{ contribute?: readonly number[] } | undefined>;
    crons?: Iterable<{ contribute?: readonly number[] } | undefined>;
}

export function playerContribute(sources: ContributeSources): Bits64 {
    const parts: (readonly number[] | undefined)[] = [sources.ship?.contribute];
    for (const [outfit, count] of sources.outfits ?? []) {
        if (count > 0) parts.push(outfit?.contribute);
    }
    for (const rank of sources.ranks ?? []) parts.push(rank?.contribute);
    for (const cron of sources.crons ?? []) parts.push(cron?.contribute);
    return orBits(...parts);
}
