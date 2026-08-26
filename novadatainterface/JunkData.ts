import { BaseData, getDefaultBaseData } from "./BaseData";

/**
 * One specialized commodity from a retail `jünk` resource.
 *
 * `soldAt` names stellars where the market sells the good to the player;
 * `boughtAt` names stellars where the market buys it from the player.
 */
export interface JunkData extends BaseData {
    soldAt: string[];
    boughtAt: string[];
    basePrice: number;
    flags: number;
    scanMask: number;
    lcName: string;
    abbreviation: string;
    buyOn: string;
    sellOn: string;
}

export function getDefaultJunkData(): JunkData {
    return {
        ...getDefaultBaseData(),
        soldAt: [],
        boughtAt: [],
        basePrice: 0,
        flags: 0,
        scanMask: 0,
        lcName: "",
        abbreviation: "",
        buyOn: "",
        sellOn: "",
    };
}
