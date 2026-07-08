import { BaseData, getDefaultBaseData } from "./base_data.js";


export interface SystemData extends BaseData {
    position: [number, number],
    links: Array<string>,
    planets: Array<string>,

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
}

export function getDefaultSystemData(): SystemData {
    return {
        ...getDefaultBaseData(),
        position: [0, 0],
        links: [],
        planets: [],
        murk: 0,
        interference: 0,
        backgroundColor: 0,
    };
}
