import { SystResource } from "../resource_parsers/syst_resource.js";
import { SystemData } from "novadatainterface/system_data";
import { BaseParse } from "./base_parse.js";
import { BaseData } from "novadatainterface/base_data";


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


    // Resolve the asteroid-type bitmask (bit 0 = röid 128) to global
    // röid ids. Only meaningful when the system has asteroids.
    const asteroidTypes: Array<string> = [];
    if (syst.asteroids > 0) {
        for (let bit = 0; bit < 16; bit++) {
            if (!(syst.asteroidTypes & (1 << bit))) {
                continue;
            }
            const roid = syst.idSpace.röid[128 + bit];
            if (roid) {
                asteroidTypes.push(roid.globalID);
            } else {
                notFoundFunction("Missing röid " + (128 + bit)
                    + " for sÿst " + base.id);
            }
        }
    }

    return {
        ...base,
        links,
        position: [syst.position[0], syst.position[1]],
        planets,
        asteroids: syst.asteroids,
        asteroidTypes,
    }

}
