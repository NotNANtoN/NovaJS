import { OutfResource } from "../resource_parsers/outf_resource.js";
import { BaseData } from "novadatainterface/base_data";
import { BaseParse } from "./base_parse.js";
import { CloakData, decodeCloakModVal, getDefaultCloakData } from "novadatainterface/cloak_data";
import { OutfitData, OutfitPhysics } from "novadatainterface/outfit_data";
import { getDefaultPictData } from "novadatainterface/pict_data";
import { FPS, OutfitTurnRateConversionFactor, ShipTurnRateConversionFactor } from "./constants.js";


// This should not be necessary!
const noUnitConversion = new Set(["freeCargo", "shield", "armor", "energy", "ionization"])
type NoUnitConversion = "freeCargo" | "shield" | "armor" | "energy" | "ionization";
const perFrameTimes1000 = new Set(["shieldRecharge", "armorRecharge"]);
type PerFrameTimes1000 = "shieldRecharge" | "armorRecharge";

export async function OutfitParse(outf: OutfResource, notFoundFunction: (m: string) => void): Promise<OutfitData> {
    var base: BaseData = await BaseParse(outf, notFoundFunction);

    // Unlike during parsing, these are objects instead of
    // lists of tuples because properties should not be repeated,
    // and objects enforce a "one value per key" requirement.
    var weapons: { [index: string]: number } = {};
    var physics: OutfitPhysics = { freeMass: outf.mass };
    // ModType 17 "cloaking device"; decoded from its ModVal bitfield. The
    // resource parser emits it as a ["cloak", modVal] function tuple.
    var cloak: CloakData = getDefaultCloakData();
    var ammoFor: string | null = null;

    for (let i in outf.functions) {
        let func = outf.functions[i];
        let fType = func[0];
        let fVal = func[1];

        if (fType === "cloak") {
            if (typeof fVal !== "number") {
                throw new Error("Wrong type for cloak val. Expected number");
            }
            cloak = decodeCloakModVal(fVal);
            continue;
        }

        // Unit conversions. Everything should be in units / second.
        // Parse weapons as well.
        // Refactor me with ship properties???
        if (fType == "weapon") {
            if (typeof fVal !== "number") {
                throw new Error("Wrong type for weapon val. Expected number");
            }

            let weap = outf.idSpace.wëap[fVal];
            if (!weap) {
                notFoundFunction("Missing wëap id " + fVal + " for oütf " + base.id);
                continue;
            }
            var weaponGlobalID = weap.globalID;

            if (!(weaponGlobalID in weapons)) {
                weapons[weaponGlobalID] = 0;
            }
            weapons[weaponGlobalID] += 1;
        }
        else if (fType == "ammunition") {
            // Each item of this outfit is one round of ammo for the
            // weapon with the given id.
            if (typeof fVal !== "number") {
                throw new Error("Wrong type for ammunition val. Expected number");
            }
            let ammoWeap = outf.idSpace.wëap[fVal];
            if (!ammoWeap) {
                notFoundFunction("Missing wëap id " + fVal + " for oütf " + base.id);
                continue;
            }
            ammoFor = ammoWeap.globalID;
        }
        else if (fType === "afterburner") {
            // ModVal is fuel units burned per second of afterburner use.
            if (typeof fVal !== "number") {
                throw new Error("Wrong type. Expected number");
            }
            physics.afterburner = fVal;
        }
        else if (noUnitConversion.has(fType)) {
            //else if (fType === "freeCargo") {
            // No unit conversion needed
            physics[<NoUnitConversion>fType] = <number>fVal;
        }
        else if (perFrameTimes1000.has(fType)) {
            // convert from (units * 1000) / frame to units / second
            if (typeof fVal !== "number") {
                throw new Error("Wrong type. Expected number");
            }
            physics[<PerFrameTimes1000>fType] = fVal * FPS / 1000;
        }
        else if (fType === "deionize") {
            if (typeof fVal !== "number") {
                throw new Error("Wrong type. Expected number");
            }
            physics[fType] = fVal * FPS / 100;
        }
        else if (fType === "turnRate") {
            if (typeof fVal !== "number") {
                throw new Error("Wrong type. Expected number");
            }
            physics[fType] = fVal * OutfitTurnRateConversionFactor;
        }
        else if (fType === "energyRecharge") {
            if (typeof fVal !== "number") {
                throw new Error("Wrong type. Expected number");
            }
            // Frames per unit of fuel -> units per second. Negative
            // values are 'fuel sucking' mode and drain instead.
            physics[fType] = fVal === 0 ? 0 : FPS / fVal;
        } else if (fType === "speed") {
            if (typeof fVal !== "number") {
                throw new Error("Wrong type. Expected number");
            }
            physics[fType] = fVal;
        } else if (fType === "acceleration") {
            if (typeof fVal !== "number") {
                throw new Error("Wrong type. Expected number");
            }
            physics[fType] = fVal;
        }
        else {
            //throw new Error("Unknown outfit function " + fType + " on outfit " + base.id);
        }
    }

    var pict: string;
    var pictResource = outf.idSpace.PICT[outf.pictID];
    if (pictResource) {
        pict = pictResource.globalID;
    }
    else {
        notFoundFunction("No matching PICT for oütf of id " + base.id);
        pict = getDefaultPictData().id;
    }

    var desc: string;
    var descResource = outf.idSpace.dësc[outf.descID];
    if (descResource) {
        desc = descResource.text;
    }
    else {
        desc = "No matching dësc for oütf of id " + base.id;
        notFoundFunction(desc);
    }

    return {
        ...base,
        weapons,
        physics,
        cloak,
        ammoFor,
        pict,
        price: outf.cost,
        desc,
        displayWeight: outf.displayWeight,
        max: outf.max
    }
}
