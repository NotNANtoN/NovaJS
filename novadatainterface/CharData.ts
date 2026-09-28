import { BaseData, getDefaultBaseData } from "./BaseData";

/**
 * EV Nova Bible, chär resource: a new pilot's starting template.
 * Resource IDs are numeric retail IDs (e.g. 128), -1 when unused.
 */
export interface CharData extends BaseData {
    cash: number;
    shipType: number;
    /** Up to four possible starting systems; -1 entries are unused. */
    systems: number[];
    /** Govt1-4 and their Status1-4 starting legal records. */
    governments: number[];
    status: number[];
    kills: number;
    introPicts: number[];
    introPictDelays: number[];
    introText: number;
    onStart: string;
    flags: number;
    startDay: number;
    startMonth: number;
    startYear: number;
    datePrefix: string;
    dateSuffix: string;
}

export function getDefaultCharData(): CharData {
    return {
        ...getDefaultBaseData(),
        cash: 10_000,
        shipType: 128,
        systems: [130, -1, -1, -1],
        governments: [-1, -1, -1, -1],
        status: [0, 0, 0, 0],
        kills: 0,
        introPicts: [-1, -1, -1, -1],
        introPictDelays: [0, 0, 0, 0],
        introText: -1,
        onStart: "",
        flags: 1,
        startDay: 18,
        startMonth: 10,
        startYear: 1177,
        datePrefix: "",
        dateSuffix: " NC",
    };
}
