import { OutfResource } from "../resource_parsers/outf_resource.js";
import { BaseData } from "novadatainterface/base_data";
import { BaseParse } from "./base_parse.js";
import { OutfitData, OutfitPhysics } from "novadatainterface/outfit_data";
import { getDefaultPictData } from "novadatainterface/pict_data";
import { FPS, OutfitTurnRateConversionFactor, ShipTurnRateConversionFactor } from "./constants.js";


// This should not be necessary!
const noUnitConversion = new Set(["freeCargo", "shield", "armor", "energy", "ionization", "maxGuns", "maxTurrets"])
type NoUnitConversion = "freeCargo" | "shield" | "armor" | "energy" | "ionization" | "maxGuns" | "maxTurrets";
const perFrameTimes1000 = new Set(["shieldRecharge", "armorRecharge"]);
type PerFrameTimes1000 = "shieldRecharge" | "armorRecharge";

export async function OutfitParse(outf: OutfResource, notFoundFunction: (m: string) => void): Promise<OutfitData> {
    var base: BaseData = await BaseParse(outf, notFoundFunction);

    // Unlike during parsing, these are objects instead of
    // lists of tuples because properties should not be repeated,
    // and objects enforce a "one value per key" requirement.
    var weapons: { [index: string]: number } = {};
    var physics: OutfitPhysics = { freeMass: outf.mass };
    let ammoFor: string | null = null;
    let increasesMax: string | null = null;
    let miningScoop = false;
    // Per-type jamming strength (IR, radar, etheric wake, gravimetric) from
    // ModTypes 33-36. Percentages, summed across the outfit's mod pairs.
    var jamming: [number, number, number, number] = [0, 0, 0, 0];

    for (let i in outf.functions) {
        let func = outf.functions[i];
        let fType = func[0];
        let fVal = func[1];

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
        else if (fType === "ammunition") {
            if (typeof fVal !== "number") {
                throw new Error("Wrong type for ammunition val. Expected number");
            }
            let ammoWeap = outf.idSpace.wëap[fVal];
            if (!ammoWeap) {
                notFoundFunction("Missing wëap id " + fVal + " for ammunition oütf " + base.id);
                continue;
            }
            ammoFor = ammoWeap.globalID;
        }
        else if (fType === "increase maximum") {
            if (typeof fVal !== "number") {
                throw new Error("Wrong type for increase maximum val. Expected number");
            }
            let maxOutf = outf.idSpace.oütf[fVal];
            if (!maxOutf) {
                notFoundFunction("Missing oütf id " + fVal + " for increase-maximum oütf " + base.id);
                continue;
            }
            increasesMax = maxOutf.globalID;
        }
        else if (fType === "mining scoop") {
            miningScoop = true;
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
            physics[fType] = FPS / fVal;
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
        else if (fType === "jam 1" || fType === "jam 2"
            || fType === "jam 3" || fType === "jam 4") {
            if (typeof fVal !== "number") {
                throw new Error("Wrong type for jamming. Expected number");
            }
            // "jam 1".."jam 4" -> index 0..3
            const idx = Number(fType.slice(4)) - 1;
            jamming[idx] += fVal;
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
        jamming,
        pict,
        price: outf.cost,
        desc,
        displayWeight: outf.displayWeight,
        max: outf.max,
        availability: outf.availability,
        onPurchase: outf.onPurchase,
        onSell: outf.onSell,
        // 64-bit flag sets as JSON-safe hex strings.
        contribute: "0x" + outf.contribute.toString(16),
        require: "0x" + outf.require.toString(16),
        fixedGun: (outf.flags & 0x1) > 0,
        turret: (outf.flags & 0x2) > 0,
        cantSell: (outf.flags & 0x8) > 0,
        ammoFor,
        increasesMax,
        miningScoop,
    }
}
