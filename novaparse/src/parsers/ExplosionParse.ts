import { NovaDataType } from "novadatainterface/NovaDataInterface";
import { BLEND_MODES } from "novadatainterface/BlendModes";
import { Animation, AnimationImage, getDefaultAnimationImage, getDefaultExitPoints } from "novadatainterface/Animation";
import { BaseData } from "novadatainterface/BaseData";
import { ExplosionData } from "novadatainterface/ExplosionData";
import { BoomResource } from "../resource_parsers/BoomResource";
import { BaseParse } from "./BaseParse";


export async function ExplosionParse(boom: BoomResource, notFoundFunction: (m: string) => void): Promise<ExplosionData> {
    var base: BaseData = await BaseParse(boom, notFoundFunction);
    var spin = boom.idSpace.spïn[boom.graphic];
    var animationImage: AnimationImage;

    if (spin) {
        var rled = spin.idSpace.rlëD[spin.spriteID]
        if (rled) {
            animationImage = {
                id: rled.globalID,
                dataType: NovaDataType.SpriteSheetImage,
                blendMode: BLEND_MODES.ADD,
                frames: {
                    normal: { start: 0, length: rled.numberOfFrames }
                }
            }
        }
        else {
            notFoundFunction("Missing rled " + spin.spriteID + " for bööm " + base.id);
            animationImage = getDefaultAnimationImage();
        }
    }
    else {
        notFoundFunction("Missing spin " + boom.graphic + " for bööm " + base.id);
        animationImage = getDefaultAnimationImage();
    }


    var animation: Animation = {
        images: {
            baseImage: animationImage
        },
        exitPoints: getDefaultExitPoints(), // Unused. Refactor???
        ...base
    };

    let soundID: string | null = null;
    if (boom.sound) {
        const snd = boom.idSpace["snd "][boom.sound];
        if (snd) {
            soundID = snd.globalID;
        } else {
            // Retail EV Nova references missing sounds (e.g. snd 314 for bööm 142)
            soundID = null;
        }
    }

    return {
        ...base,
        animation,
        sound: soundID,
        rate: boom.animationRate / 100
    }
};
