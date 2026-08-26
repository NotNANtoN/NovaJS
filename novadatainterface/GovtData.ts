import { BaseData, getDefaultBaseData } from "./BaseData";

/**
 * Government relation data needed by encoded mission selectors.
 *
 * The values in these arrays are normally government IDs (128-383), but the
 * selector also accepts zero-based indexes so parsed and hand-authored data
 * can be consumed by the same resolver.
 */
export interface GovtData extends BaseData {
    /** Map colour used for this government's territory, as 0xRRGGBB. */
    color?: number;
    flags?: number;
    flags2?: number;
    scanFine?: number;
    /** Longer name used in prose, e.g. "the Federation". */
    mediumName?: string;
    /**
     * How far the player's legal record may fall before this government
     * treats them as a criminal, and the record a new pilot starts with.
     */
    crimeTolerance?: number;
    initialRecord?: number;
    /** How much each crime costs the player's record with this government. */
    penalties?: {
        smuggling: number;
        disabling: number;
        boarding: number;
        killing: number;
        shooting: number;
    };
    classes: number[];
    allies: number[];
    enemies: number[];
    relations?: {
        classes: number[];
        allies: number[];
        enemies: number[];
    };
}

export function getDefaultGovtData(): GovtData {
    return {
        ...getDefaultBaseData(),
        classes: [],
        allies: [],
        enemies: [],
    };
}
