import { OopsData } from "novadatainterface/oops_data";
import { BaseData } from "novadatainterface/base_data";
import { OopsResource } from "../resource_parsers/oops_resource.js";
import { BaseParse } from "./base_parse.js";

/**
 * Maps a parsed öops resource onto the OopsData shape. The Stellar field
 * (a local spöb id) resolves to a global id — the same key scheme
 * PlanetData / SystemData.planets use — so the trade UI can match an
 * event against the planet the player is docked at.
 *
 * Stellar = -1 means "any planet or station" (appliesToAll); Stellar =
 * -2 (or any other non-positive sentinel) means the öops is not a price
 * event and matches no stellar.
 */
export async function OopsParse(oops: OopsResource,
    notFoundFunction: (m: string) => void): Promise<OopsData> {
    const base: BaseData = await BaseParse(oops, notFoundFunction);

    let stellar: string | null = null;
    const appliesToAll = oops.stellar === -1;
    if (oops.stellar >= 128) {
        const spob = oops.idSpace.spöb[oops.stellar];
        if (spob) {
            stellar = spob.globalID;
        } else {
            notFoundFunction(
                `No spöb ${oops.stellar} for öops ${base.id} stellar`);
        }
    }

    return {
        ...base,
        stellar,
        appliesToAll,
        commodity: oops.commodity,
        priceDelta: oops.priceDelta,
        duration: oops.duration,
        freq: oops.freq,
        activateOn: oops.activateOn,
    };
}
