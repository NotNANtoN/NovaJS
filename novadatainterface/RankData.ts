import { BaseData, getDefaultBaseData } from "./BaseData";

/**
 * EV Nova Bible, ränk resource. Contribute is [high word, low word] of the
 * 64-bit flag that is ORed into the player's Contribute while active.
 */
export interface RankData extends BaseData {
    weight: number;
    government: number;
    /** Percent price for items and ships at the affiliated govt's stellars. */
    priceMod: number;
    salary: number;
    salaryCap: number;
    contribute: number[];
    flags: number;
    convName: string;
    shortName: string;
}

export function getDefaultRankData(): RankData {
    return {
        ...getDefaultBaseData(),
        weight: 0,
        government: -1,
        priceMod: 100,
        salary: 0,
        salaryCap: 0,
        contribute: [0, 0],
        flags: 0,
        convName: "",
        shortName: "",
    };
}
