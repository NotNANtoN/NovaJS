import { SystResource } from "../resource_parsers/SystResource";
import { SystemData } from "novadatainterface/SystemData";
import { BaseParse } from "./BaseParse";
import { BaseData } from "novadatainterface/BaseData";


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
            }
            else {
                notFoundFunction("Missing düde id " + localID + " for sÿst " + base.id);
            }
        }
        else if (localID <= -128) {
            var flet = syst.idSpace.flët[-localID];
            if (flet) {
                dudes.push({ id: flet.globalID, weight });
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
        avgShips: syst.avgShips
    }

}
