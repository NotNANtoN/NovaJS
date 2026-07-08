import { BaseData, getDefaultBaseData } from "./base_data.js";


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
    };
}
