import { Animation, getDefaultAnimationImage, getDefaultExitPoints } from "novadatainterface/animation";
import { BaseData } from "novadatainterface/base_data";
import { NovaDataType } from "novadatainterface/nova_data_interface";
import { getDefaultPictData } from "novadatainterface/pict_data";
import { GateData, PlanetData } from "novadatainterface/planet_data";
import { DamageType } from "novadatainterface/weapon_data";
import { BLEND_MODES } from "novadatainterface/blend_modes";
import { SpobResource } from "../resource_parsers/spob_resource.js";
import { BaseParse } from "./base_parse.js";


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
    var pict = spob.idSpace.PICT[spob.landingPictID]
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

    // Hypergate / wormhole transit metadata. The spöb HyperLink fields hold
    // local spöb ids of the connected gates/wormholes; resolve each to its
    // global id (the same key SystemData.planets uses) so transit can find the
    // destination stellar and the system it lives in.
    let gate: GateData | null = null;
    if (spob.isHypergate || spob.isWormhole) {
        const destinations: string[] = [];
        for (const linkLocal of spob.hyperlinks) {
            const linkedSpob = spob.idSpace.spöb[linkLocal];
            if (linkedSpob) {
                destinations.push(linkedSpob.globalID);
            } else {
                notFoundFunction("No corresponding spöb " + linkLocal
                    + " for hyperlink from spöb " + base.id);
            }
        }
        // CustSndID doubles as the emergence angle for gates/wormholes: 0-359
        // is an exact angle, anything else means a random direction (Bible
        // p. 60). null signals "random" so the transit code can pick a
        // seeded-random angle deterministically.
        const angle = spob.ambientSound;
        const emergenceAngle = (angle >= 0 && angle <= 359) ? angle : null;
        gate = {
            // Hypergate and wormhole are independent bits; if a stellar somehow
            // sets both, treat it as a hypergate (offers an explicit choice).
            kind: spob.isHypergate ? "hypergate" : "wormhole",
            destinations,
            emergenceAngle,
        };
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

    // Resolve the owning gövt to its global id; -1 and other sentinel
    // values stay null (independent).
    let govt: string | null = null;
    if (spob.government >= 128) {
        govt = spob.idSpace.gövt[spob.government]?.globalID ?? null;
    }

    return {
        ...base,
        landingDesc: desc,
        landingPict: pictID,
        animation,
        govt,
        flags: {
            canLand: Boolean(spob.flags & 0x1),
            hasCommodityExchange: Boolean(spob.flags & 0x2),
            hasOutfitter: Boolean(spob.flags & 0x4),
            hasShipyard: Boolean(spob.flags & 0x8),
            isStation: Boolean(spob.flags & 0x10),
            uninhabited: Boolean(spob.flags & 0x20),
            hasBar: Boolean(spob.flags & 0x40),
            landOnlyIfDestroyed: Boolean(spob.flags & 0x80),
        },
        techLevel: spob.techLevel,
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
        gate,
        landingFee: spob.landingFee,
    }
}
