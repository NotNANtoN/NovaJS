import { BaseData, getDefaultBaseData } from "./base_data.js";


/**
 * One NPC spawn entry from the sÿst DudeTypes table: a global dude or
 * fleet id with a percent-probability weight. Weights are normalized at
 * selection time (the Bible allows them to sum to less than 100).
 */
export interface SystemSpawnChance {
    /** Global düde or flët id. */
    id: string;
    /** Percent probability weight (sÿst "% Prob", 1-99). */
    weight: number;
}

export interface SystemData extends BaseData {
    position: [number, number],
    links: Array<string>,
    planets: Array<string>,
    /**
     * How many asteroids to keep near the player at once (0-16). The
     * original engine treats this as a per-screen density: that many
     * asteroids always drift within the visible area, wrapping around
     * its edges.
     */
    asteroids: number,
    /** Global ids of the asteroid types that appear in this system. */
    asteroidTypes: Array<string>,

    /**
     * How murky (hazy) the system is, from 0 to 100. Zero renders normally;
     * higher values fog the view. A value below zero is equivalent to zero
     * murk but also hides the starfield. See the EVN Bible's sÿst docs.
     */
    murk: number,

    /**
     * How thick the sensor static in the system is, from 0 to 100. Zero is a
     * clear radar; 100 is a complete sensor blackout.
     */
    interference: number,

    /**
     * The system's background colour as 0x00RRGGBB. Zero is pure black.
     */
    backgroundColor: number,

    /**
     * NCB test expression controlling whether the system exists for the
     * player. Blank means always visible. Nova swaps between alternate
     * copies of a system (stacked at the same map position) by giving each
     * a different visibility expression.
     */
    visibility: string,

    /**
     * The dude classes AI ships spawned in this system are drawn from
     * (sÿst DudeTypes with positive ids), with percent weights.
     */
    dudes: Array<SystemSpawnChance>,

    /**
     * The fleets spawned through this system's DudeTypes table
     * (DudeTypes entries -128 to -383 reference flët -id), with percent
     * weights. Distinct from fleets that roam in via their own LinkSyst
     * ranges (see FleetData.linkSyst).
     */
    fleets: Array<SystemSpawnChance>,

    /**
     * The average number of AI ships in the system (sÿst AvgShips,
     * +/- 50% per the Bible). Zero means an empty system.
     */
    avgShips: number,

    /** Global id of the owning government, or null for independent. */
    govt: string | null,
}

export function getDefaultSystemData(): SystemData {
    return {
        ...getDefaultBaseData(),
        position: [0, 0],
        links: [],
        planets: [],
        asteroids: 0,
        asteroidTypes: [],
        murk: 0,
        interference: 0,
        backgroundColor: 0,
        visibility: '',
        dudes: [],
        fleets: [],
        avgShips: 0,
        govt: null,
    };
}
