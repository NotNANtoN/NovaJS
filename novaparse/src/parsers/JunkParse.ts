import { JunkData } from "novadatainterface/JunkData";
import { JunkResource } from "../resource_parsers/JunkResource";
import { BaseParse } from "./BaseParse";

function stellarIDs(
    junk: JunkResource,
    localIDs: readonly number[],
    field: "SoldAt" | "BoughtAt",
    notFoundFunction: (message: string) => void,
): string[] {
    return localIDs
        .filter(id => id !== 0 && id !== -1)
        .map(id => {
            const stellar = junk.idSpace.spöb[id];
            if (!stellar) {
                notFoundFunction(
                    `Missing spöb ${id} in ${field} for jünk ${junk.globalID}`);
                return undefined;
            }
            return stellar.globalID;
        })
        .filter((id): id is string => id !== undefined);
}

export async function JunkParse(
    junk: JunkResource,
    notFoundFunction: (message: string) => void,
): Promise<JunkData> {
    const base = await BaseParse(junk, notFoundFunction);
    return {
        ...base,
        soldAt: stellarIDs(
            junk, junk.soldAt, "SoldAt", notFoundFunction),
        boughtAt: stellarIDs(
            junk, junk.boughtAt, "BoughtAt", notFoundFunction),
        basePrice: junk.basePrice,
        flags: junk.flags,
        scanMask: junk.scanMask,
        lcName: junk.lcName,
        abbreviation: junk.abbreviation,
        buyOn: junk.buyOn,
        sellOn: junk.sellOn,
    };
}
