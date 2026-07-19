import { FleetData, FleetEscortChoice, FleetLinkSyst } from "novadatainterface/fleet_data";
import { BaseData } from "novadatainterface/base_data";
import { FletResource } from "../resource_parsers/flet_resource.js";
import { BaseParse } from "./base_parse.js";
import { NovaResources } from "../resource_parsers/resource_holder_base.js";


/**
 * Resolves a flët LinkSyst value to the discriminated FleetLinkSyst
 * union, mapping the govt-relative ranges (10000/15000/20000/25000 +
 * offset, where the offset is the govt id - 128) to global govt ids.
 * See the EVN Bible's flët section.
 */
function parseLinkSyst(linkSyst: number, idSpace: NovaResources,
    fleetId: string, notFoundFunction: (m: string) => void): FleetLinkSyst {
    if (linkSyst >= 128 && linkSyst <= 2175) {
        const syst = idSpace.sÿst[linkSyst];
        if (!syst) {
            // Soft reference (see system_parse.ts): warn and degrade.
            console.warn("Missing sÿst id " + linkSyst
                + " for flët " + fleetId + " LinkSyst");
            return { type: 'any' };
        }
        return { type: 'system', id: syst.globalID };
    }

    for (const [start, type] of [
        [10000, 'govtSystems'],
        [15000, 'allySystems'],
        [20000, 'notGovtSystems'],
        [25000, 'enemySystems'],
    ] as const) {
        if (linkSyst >= start && linkSyst <= start + 255) {
            const govtId = 128 + linkSyst - start;
            const govt = idSpace.gövt[govtId];
            if (!govt) {
                console.warn("Missing gövt id " + govtId
                    + " for flët " + fleetId + " LinkSyst");
                return { type: 'any' };
            }
            return { type, govt: govt.globalID };
        }
    }

    // -1 (and anything unrecognized) means any system.
    return { type: 'any' };
}

/**
 * Maps a parsed flët resource onto the FleetData shape served through
 * the data interface: local shïp/gövt/sÿst references resolve to global
 * ids, and the raw LinkSyst id ranges resolve to a discriminated union.
 */
export async function FleetParse(fleet: FletResource,
    notFoundFunction: (m: string) => void): Promise<FleetData> {
    const base: BaseData = await BaseParse(fleet, notFoundFunction);

    const lead = fleet.idSpace.shïp[fleet.leadShip];
    if (!lead) {
        // A fleet without a lead ship cannot spawn at all.
        throw new Error("Missing lead shïp id " + fleet.leadShip
            + " for flët " + base.id);
    }

    // Escorts and the govt are soft references (see system_parse.ts):
    // drop/degrade with a warning instead of failing the whole flët.
    const escorts: FleetEscortChoice[] = [];
    for (const { id, min, max } of fleet.escorts) {
        const ship = fleet.idSpace.shïp[id];
        if (!ship) {
            console.warn("Missing escort shïp id " + id
                + " for flët " + base.id);
            continue;
        }
        // The Bible has creators point unused escort slots at a valid
        // ship class with min = max = 0; keep only slots that can
        // actually contribute ships.
        if (max <= 0) {
            continue;
        }
        escorts.push({ id: ship.globalID, min: Math.max(0, min), max });
    }

    let govt: string | null = null;
    if (fleet.govt >= 128) {
        const govtResource = fleet.idSpace.gövt[fleet.govt];
        if (govtResource) {
            govt = govtResource.globalID;
        } else {
            console.warn("Missing gövt id " + fleet.govt
                + " for flët " + base.id);
        }
    }

    return {
        ...base,
        leadShip: lead.globalID,
        escorts,
        govt,
        linkSyst: parseLinkSyst(fleet.linkSyst, fleet.idSpace, base.id,
            notFoundFunction),
        appearOn: fleet.appearOn,
    };
}
