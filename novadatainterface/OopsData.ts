import { BaseData, getDefaultBaseData } from "./BaseData";

export interface OopsData extends BaseData {
    stellar: number;
    commodity: number;
    priceDelta: number;
    duration: number;
    freq: number;
    activateOn: string;
}

export function getDefaultOopsData(): OopsData {
    return {
        ...getDefaultBaseData(),
        stellar: -1,
        commodity: 0,
        priceDelta: 0,
        duration: 0,
        freq: 0,
        activateOn: "",
    };
}
