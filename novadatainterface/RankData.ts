import { BaseData, getDefaultBaseData } from "./BaseData";

export interface RankData extends BaseData {
    weight: number;
    government: number;
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
        salary: 0,
        salaryCap: 0,
        contribute: [0, 0],
        flags: 0,
        convName: "",
        shortName: "",
    };
}
