/**
 * Pure text-content logic for the status bar's readouts, kept free of PIXI and
 * ECS so the rules are unit-testable. The rendering systems resolve components
 * and game data, then hand plain values to these helpers.
 */

/** One line of the cargo manifest: an (abbreviated) name and a quantity. */
export interface CargoLine {
    name: string;
    quantity: number;
}

/** What the "Stellar Navigation" panel shows. */
export interface NavReadout {
    /** "Stellar Navigation" normally, "Hyperspace" while a jump route is set. */
    header: string;
    /** The destination/selection name, or "No Destination". */
    value: string;
    /** Whether the value is the dim "No Destination" placeholder. */
    dim: boolean;
}

/**
 * The navigation readout: a set jump route shows "Hyperspace" + the next
 * system; otherwise a selected stellar shows "Stellar Navigation" + its name;
 * with neither, the dim "No Destination" placeholder (matching the original's
 * space/board_ship reference).
 */
export function navReadout(destinationSystem: string | null,
    selectedStellar: string | null): NavReadout {
    if (destinationSystem) {
        return { header: 'Hyperspace', value: destinationSystem, dim: false };
    }
    if (selectedStellar) {
        return { header: 'Stellar Navigation', value: selectedStellar, dim: false };
    }
    return { header: 'Stellar Navigation', value: 'No Destination', dim: true };
}

/**
 * Formats a credit balance the way the original status bar does: comma-grouped
 * up to a million ("546,553"), then abbreviated to two decimals ("2.10M",
 * "1.34B") so large fortunes stay inside the narrow status column.
 */
export function formatCredits(credits: number): string {
    const n = Math.max(0, Math.floor(credits));
    if (n >= 1e9) {
        return `${(n / 1e9).toFixed(2)}B`;
    }
    if (n >= 1e6) {
        return `${(n / 1e6).toFixed(2)}M`;
    }
    return n.toLocaleString('en-US');
}

/**
 * The standard commodities abbreviate to fit the cargo column exactly as the
 * original status bar shows them ("Ind", "Med", "LuxG", "Met", "Equ"). Junk
 * and other names fall back to their first few characters.
 */
const STANDARD_CARGO_ABBREV: Readonly<Record<string, string>> = {
    'Food': 'Food',
    'Industrial': 'Ind',
    'Medical Supplies': 'Med',
    'Luxury Goods': 'LuxG',
    'Metal': 'Met',
    'Equipment': 'Equ',
};

export function abbreviateCargoName(name: string): string {
    return STANDARD_CARGO_ABBREV[name] ?? (name.length > 5 ? name.slice(0, 4) : name);
}

/**
 * Summarizes the "Special:" mission-cargo line: nothing when the player carries
 * no mission cargo, the single cargo's name when there's exactly one, and
 * "Multiple" when several missions contribute cargo (as the original shows).
 */
export function specialCargoSummary(names: readonly string[]): string | null {
    if (names.length === 0) {
        return null;
    }
    if (names.length === 1) {
        return names[0];
    }
    return 'Multiple';
}

/** Index of a standard-commodity cargo key ("cargo:3" -> 3), or null. */
export function standardCargoIndex(key: string): number | null {
    const match = /^cargo:(\d+)$/.exec(key);
    return match ? Number(match[1]) : null;
}

const FULL_MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December',
];

/** The English ordinal for a day of the month: 1 -> "1st", 22 -> "22nd". */
export function ordinal(n: number): string {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) {
        return `${n}th`;
    }
    switch (n % 10) {
        case 1: return `${n}st`;
        case 2: return `${n}nd`;
        case 3: return `${n}rd`;
        default: return `${n}th`;
    }
}

/**
 * The long date the game shows in status messages, e.g.
 * "November 21st, 1177 NC" (the suffix is the scenario's dateSuffix).
 */
export function formatLongDate(date: { day: number, month: number, year: number },
    suffix = ''): string {
    const month = FULL_MONTH_NAMES[date.month - 1] ?? `Month ${date.month}`;
    return `${month} ${ordinal(date.day)}, ${date.year}${suffix}`;
}

/** The bottom-left "Jumping into ..." message shown on entering a system. */
export function jumpArrivalMessage(systemName: string,
    date: { day: number, month: number, year: number }, suffix = ''): string {
    return `Jumping into the ${systemName} system on ${formatLongDate(date, suffix)}.`;
}
