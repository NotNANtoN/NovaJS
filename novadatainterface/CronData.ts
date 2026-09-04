import { BaseData, getDefaultBaseData } from "./BaseData";

export interface CronData extends BaseData {
    firstDay: number;
    firstMonth: number;
    firstYear: number;
    lastDay: number;
    lastMonth: number;
    lastYear: number;
    random: number;
    duration: number;
    preHoldoff: number;
    postHoldoff: number;
    indNewsStr: number;
    flags: number;
    enableOn: string;
    onStart: string;
    onEnd: string;
    contribute: number[];
    require: number[];
    newsGovt: number[];
    govtNewsStr: number[];
}

export function getDefaultCronData(): CronData {
    return {
        ...getDefaultBaseData(),
        firstDay: 0,
        firstMonth: 0,
        firstYear: 0,
        lastDay: 0,
        lastMonth: 0,
        lastYear: 0,
        random: 100,
        duration: 0,
        preHoldoff: 0,
        postHoldoff: 0,
        indNewsStr: -1,
        flags: 0,
        enableOn: "",
        onStart: "",
        onEnd: "",
        contribute: [0, 0],
        require: [0, 0],
        newsGovt: [-1, -1, -1, -1],
        govtNewsStr: [-1, -1, -1, -1],
    };
}
