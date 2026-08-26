import { PersData } from "novadatainterface/PersData";
import { BaseParse } from "./BaseParse";
import { PersResource } from "../resource_parsers/PersResource";

function resolveReference(
    pers: PersResource,
    id: number,
    resourceType: keyof PersResource["idSpace"],
    notFoundFunction: (message: string) => void,
): string | null {
    if (id <= 0) {
        return null;
    }
    const resource = pers.idSpace[resourceType][id];
    if (!resource) {
        notFoundFunction(
            `Missing ${resourceType} id ${id} for përs ${pers.globalID}`,
        );
        return null;
    }
    return resource.globalID;
}

function resolveSystemSelector(
    pers: PersResource,
    value: number,
    notFoundFunction: (message: string) => void,
): string | number {
    if (value < 128 || value > 2175) {
        return value;
    }
    return resolveReference(pers, value, "sÿst", notFoundFunction) ?? value;
}

export async function PersParse(
    pers: PersResource,
    notFoundFunction: (message: string) => void,
): Promise<PersData> {
    const base = await BaseParse(pers, notFoundFunction);
    return {
        ...base,
        linkSyst: resolveSystemSelector(
            pers, pers.linkSyst, notFoundFunction),
        government: pers.government,
        aiType: pers.aiType,
        aggress: pers.aggress,
        coward: pers.coward,
        shipType: resolveReference(
            pers, pers.shipType, "shïp", notFoundFunction) ?? "",
        weaponTypes: pers.weaponTypes.map(id =>
            resolveReference(pers, id, "wëap", notFoundFunction)),
        weaponCounts: [...pers.weaponCounts],
        ammoLoads: [...pers.ammoLoads],
        credits: pers.credits,
        shieldMod: pers.shieldMod,
        hailPict: resolveReference(
            pers, pers.hailPict, "PICT", notFoundFunction),
        commQuote: pers.commQuote,
        hailQuote: pers.hailQuote,
        linkMission: resolveReference(
            pers, pers.linkMission, "mïsn", notFoundFunction),
        flags: pers.flags,
        activeOn: pers.activeOn,
        shipSubtitle: pers.shipSubtitle,
        grantClass: pers.grantClass,
        grantProb: pers.grantProb,
        grantCount: pers.grantCount,
        color: pers.colour,
        flags2: pers.flags2,
    };
}
