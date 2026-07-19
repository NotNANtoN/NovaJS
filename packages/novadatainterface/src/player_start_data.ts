import { BaseData, getDefaultBaseData } from "./base_data.js";

/** A calendar date as EV Nova stores it. */
export interface GameDate {
    /** Day of the month, 1-31. */
    day: number;
    /** Month, 1-12. */
    month: number;
    year: number;
}

/**
 * A "character template" ("chär"): an entry point for a new pilot.
 * Selecting one sets the starting ship, credits, systems, legal
 * records, and start date.
 *
 * The intro PICT sequence is not carried (no intro sequence is
 * implemented); the intro dësc text is resolved to a string at parse
 * time like mission briefings are.
 */
export interface PlayerStartData extends BaseData {
    /** Credits the player starts with. */
    credits: number;
    /** Global id of the starting ship type (e.g. "nova:128"). */
    ship: string;
    /**
     * Global ids of the systems the player may (randomly) start in.
     * Empty means the scenario's default start system.
     */
    systems: string[];
    /** The game date at the start of a new pilot. */
    date: GameDate;
    /** String shown before the date whenever it is displayed. */
    datePrefix: string;
    /** String shown after the date whenever it is displayed. */
    dateSuffix: string;
    /** NCB set expression run when a new pilot of this type starts. */
    onStart: string;
    /** Intro text shown at game start; "" if none. */
    introText: string;
    /** Starting combat rating (kills). */
    combatRating: number;
    /** Whether this chär is the default in the new-pilot menu. */
    isDefault: boolean;
    /**
     * Starting legal statuses, keyed by global gövt id. The negative
     * of the status applies in enemy-owned systems.
     */
    govtStatuses: { govt: string, status: number }[];
}

export function getDefaultGameDate(): GameDate {
    // EV Nova's stock scenario starts in October 1177 NC; a neutral
    // default for scenarios with no chär.
    return { day: 1, month: 1, year: 1177 };
}

export function getDefaultPlayerStartData(): PlayerStartData {
    return {
        ...getDefaultBaseData(),
        credits: 10000,
        ship: "default",
        systems: [],
        date: getDefaultGameDate(),
        datePrefix: "",
        dateSuffix: "",
        onStart: "",
        introText: "",
        combatRating: 0,
        isDefault: false,
        govtStatuses: [],
    };
}
