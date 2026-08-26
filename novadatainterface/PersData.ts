import { BaseData, getDefaultBaseData } from "./BaseData";
import * as t from "io-ts";

export const PersDataCodec = t.type({
    name: t.string,
    id: t.string,
    prefix: t.string,
    linkSyst: t.union([t.string, t.number]),
    government: t.number,
    aiType: t.number,
    aggress: t.number,
    coward: t.number,
    shipType: t.string,
    weaponTypes: t.array(t.union([t.string, t.null])),
    weaponCounts: t.array(t.number),
    ammoLoads: t.array(t.number),
    credits: t.number,
    shieldMod: t.number,
    hailPict: t.union([t.string, t.null]),
    commQuote: t.number,
    hailQuote: t.number,
    linkMission: t.union([t.string, t.null]),
    flags: t.number,
    activeOn: t.string,
    shipSubtitle: t.string,
    grantClass: t.number,
    grantProb: t.number,
    grantCount: t.number,
    color: t.number,
    flags2: t.number,
});

export interface PersData extends BaseData {
    /**
     * A system ID for a concrete system selector, or the raw encoded
     * government/system selector for the other LinkSyst forms.
     */
    linkSyst: string | number;
    government: number;
    aiType: number;
    aggress: number;
    coward: number;
    shipType: string;
    weaponTypes: Array<string | null>;
    weaponCounts: number[];
    ammoLoads: number[];
    credits: number;
    shieldMod: number;
    hailPict: string | null;
    commQuote: number;
    hailQuote: number;
    linkMission: string | null;
    flags: number;
    activeOn: string;
    shipSubtitle: string;
    grantClass: number;
    grantProb: number;
    grantCount: number;
    color: number;
    flags2: number;
}

export function getDefaultPersData(): PersData {
    return {
        ...getDefaultBaseData(),
        linkSyst: -1,
        government: -1,
        aiType: 1,
        aggress: 1,
        coward: 0,
        shipType: "",
        weaponTypes: [null, null, null, null],
        weaponCounts: [0, 0, 0, 0],
        ammoLoads: [0, 0, 0, 0],
        credits: 0,
        shieldMod: 100,
        hailPict: null,
        commQuote: -1,
        hailQuote: -1,
        linkMission: null,
        flags: 0,
        activeOn: "",
        shipSubtitle: "",
        grantClass: -1,
        grantProb: 0,
        grantCount: 0,
        color: 0,
        flags2: 0,
    };
}
