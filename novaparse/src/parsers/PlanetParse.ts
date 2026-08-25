import { Animation, getDefaultAnimationImage, getDefaultExitPoints } from "novadatainterface/Animation";
import { BaseData } from "novadatainterface/BaseData";
import { NovaDataType } from "novadatainterface/NovaDataInterface";
import { getDefaultPictData } from "novadatainterface/PictData";
import { PlanetData } from "novadatainterface/PlanetData";
import { DamageType } from "novadatainterface/WeaponData";
import { BLEND_MODES } from "novadatainterface/BlendModes";
import { SpobResource } from "../resource_parsers/SpobResource";
import { BaseParse } from "./BaseParse";


export async function PlanetParse(spob: SpobResource, notFoundFunction: (m: string) => void): Promise<PlanetData> {
    var base: BaseData = await BaseParse(spob, notFoundFunction);

    const defaultPictData = getDefaultPictData();
    const defaultAnimationImage = getDefaultAnimationImage();

    var desc: string;
    var descResource = spob.idSpace.dësc[spob.landingDescID];
    if (descResource) {
        desc = descResource.text;
    }
    else {
        desc = "No matching dësc for spöb of id " + base.id;
        notFoundFunction(desc);
    }

    var pictID: string;
    // The Bible reserves CustPicID values below 128 for the standard
    // landscape. Never try to resolve those values as resource IDs.
    var pict = spob.landingPictID >= 128
        ? spob.idSpace.PICT[spob.landingPictID]
        : undefined;
    if (pict) {
        pictID = pict.globalID;
    }
    else {
        notFoundFunction("No matching PICT for spöb of id " + base.id);
        pictID = defaultPictData.id;
    }

    var rledResource = spob.idSpace.rlëD[spob.graphic];
    var rledID: string;
    if (rledResource) {
        rledID = rledResource.globalID;
    }
    else {
        notFoundFunction("No matching rlëd id " + spob.graphic + " for spöb of id " + base.id);
        rledID = defaultAnimationImage.id;
    }

    const animation: Animation = {
        exitPoints: getDefaultExitPoints(),
        id: base.id,
        name: base.name,
        prefix: base.prefix,
        images: {
            baseImage: {
                id: rledID,
                dataType: NovaDataType.SpriteSheetImage,
                blendMode: BLEND_MODES.NORMAL,
                frames: {
                    normal: { start: 0, length: 1 }
                }
            }

        }
    };

    return {
        ...base,
        landingDesc: desc,
        landingPict: pictID,
        animation,
        vulnerableTo: <Array<DamageType>>["planetBuster"],
        physics: {
            shield: 1000,
            shieldRecharge: 1000,
            armor: 1000,
            armorRecharge: 1000,
            acceleration: 0,
            speed: 0,
            deionize: 0,
            energy: 0,
            energyRecharge: 0,
            ionization: 0,
            mass: 0,
            turnRate: 0,
            inertialess: true,
        },
        position: [spob.position[0], spob.position[1]],
        flags: spob.flags,
        techLevel: spob.techLevel,
        specialTech: [...spob.specialTech],
        canLand: (spob.flags & 0x00000001) !== 0,
        government: spob.government,
        inhabited: (spob.flags & 0x20) === 0,
        hasCommodityExchange: (spob.flags & 0x00000002) !== 0,
        hasOutfitter: (spob.flags & 0x00000004) !== 0,
        hasShipyard: (spob.flags & 0x00000008) !== 0,
        hasBar: (spob.flags & 0x00000040) !== 0,
        tradeCommodities: spob.tradeCommodities,
    }
}
