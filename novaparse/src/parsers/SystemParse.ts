import { SystResource } from "../resource_parsers/SystResource";
import {
    NpcShipSpawnData,
    NpcSpawnData,
    SystemData,
} from "novadatainterface/SystemData";
import { BaseParse } from "./BaseParse";
import { BaseData } from "novadatainterface/BaseData";
import { NovaResources } from "../resource_parsers/ResourceHolderBase";

export function combatRoleForDudeAiType(
    aiType: number,
): NpcSpawnData["combatRole"] {
    // EV Nova Bible: 1/2 are traders; 3 is warship; 4 is interceptor/
    // piracy police. AIType 0 delegates to ship data, which the current
    // parser does not retain, so use the conservative personal-only role.
    if (aiType === 3 || aiType === 4) {
        return "military";
    }
    if (aiType === 1 || aiType === 2) {
        return "civilian";
    }
    return "personal";
}


function resolveShips(
    shipTypes: number[],
    weights: number[],
    idSpace: NovaResources,
    notFoundFunction: (message: string) => void,
    context: string,
): NpcShipSpawnData[] {
    const ships: NpcShipSpawnData[] = [];
    for (let i = 0; i < shipTypes.length; i++) {
        const localID = shipTypes[i];
        const weight = weights[i];
        if (localID <= 0 || weight <= 0) {
            continue;
        }

        const ship = idSpace.shïp[localID];
        if (!ship) {
            notFoundFunction("Missing shïp id " + localID + " for " + context);
            continue;
        }
        ships.push({ id: ship.globalID, weight });
    }
    return ships;
}


// TODO: Refactor redundant code
export async function SystemParse(syst: SystResource, notFoundFunction: (m: string) => void): Promise<SystemData> {
    var base: BaseData = await BaseParse(syst, notFoundFunction);

    var links: Array<string> = [];
    for (let i in [...syst.links]) {
        let linkLocal = [...syst.links][i];

        let systLinkedTo = syst.idSpace.sÿst[linkLocal];
        if (systLinkedTo) {
            links.push(systLinkedTo.globalID);
        }
        else {
            notFoundFunction("No corresponding system " + linkLocal + " for link from " + base.id);
        }
    }

    var planets: Array<string> = [];

    for (let i in syst.spobs) {
        let planetLocal = syst.spobs[i];

        let planetGlobal = syst.idSpace.spöb[planetLocal];
        if (planetGlobal) {
            planets.push(planetGlobal.globalID);
        }
        else {
            notFoundFunction("Missing spöb id " + planetLocal + " for sÿst " + base.id);
        }
    }

    var dudes: Array<{ id: string, weight: number }> = [];
    var npcs: Array<NpcSpawnData> = [];
    for (var i = 0; i < syst.dudeTypes.length; i++) {
        var localID = syst.dudeTypes[i];
        var weight = syst.dudeProbabilities[i];
        if (localID === 0 || localID === -1 || weight <= 0) {
            continue;
        }

        // Positive entries name düde resources. Negative entries name
        // flët resources (for example -129 means flët 129).
        if (localID >= 128) {
            var dude = syst.idSpace.düde[localID];
            if (dude) {
                dudes.push({ id: dude.globalID, weight });
                npcs.push({
                    id: dude.globalID,
                    weight,
                    government: dude.government,
                    combatRole: combatRoleForDudeAiType(dude.aiType),
                    ships: resolveShips(
                        dude.shipTypes,
                        dude.probabilities,
                        syst.idSpace,
                        notFoundFunction,
                        "düde " + dude.globalID,
                    ),
                });
            }
            else {
                notFoundFunction("Missing düde id " + localID + " for sÿst " + base.id);
            }
        }
        else if (localID <= -128) {
            var flet = syst.idSpace.flët[-localID];
            if (flet) {
                dudes.push({ id: flet.globalID, weight });
                // A flët has no per-ship probabilities. Include its lead ship
                // and active escort classes as equally likely fallback spawn
                // choices. Slots with no escorts are intentionally ignored.
                const activeEscorts = flet.escortTypes.filter((_type, index) =>
                    flet.minEscorts[index] > 0 || flet.maxEscorts[index] > 0);
                const shipTypes = [flet.leadShipType, ...activeEscorts];
                npcs.push({
                    id: flet.globalID,
                    weight,
                    government: flet.government,
                    // flët resources explicitly describe coordinated military
                    // groups rather than unrelated ambient traders.
                    combatRole: "military",
                    ships: resolveShips(
                        shipTypes,
                        shipTypes.map(() => 1),
                        syst.idSpace,
                        notFoundFunction,
                        "flët " + flet.globalID,
                    ),
                });
            }
            else {
                notFoundFunction("Missing flët id " + (-localID) + " for sÿst " + base.id);
            }
        }
    }


    return {
        ...base,
        links,
        position: [syst.position[0], syst.position[1]],
        planets,
        dudes,
        npcs,
        avgShips: syst.avgShips,
        government: syst.government,
    }

}
