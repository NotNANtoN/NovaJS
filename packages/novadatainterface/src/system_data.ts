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
}

export function getDefaultSystemData(): SystemData {
    return {
        ...getDefaultBaseData(),
        position: [0, 0],
        links: [],
        planets: [],
        asteroids: 0,
        asteroidTypes: [],
    };
}
