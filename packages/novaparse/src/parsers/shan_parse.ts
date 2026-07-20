import { Animation, AnimationFrames, AnimationImages, BlinkPattern, getDefaultAnimationImage } from "novadatainterface/animation";
import { BaseData } from "novadatainterface/base_data";
import { NovaDataType } from "novadatainterface/nova_data_interface";
import { NovaIDNotFoundError } from "novadatainterface/nova_data_interface";
import { BLEND_MODES } from "novadatainterface/blend_modes";
import { ShanResource } from "../resource_parsers/shan_resource.js";
import { BaseParse } from "./base_parse.js";


export async function ShanParse(shan: ShanResource, notFoundFunction: (message: string) => void): Promise<Animation> {
    var base: BaseData = await BaseParse(shan, notFoundFunction);

    var images: AnimationImages = {
        baseImage: getDefaultAnimationImage()
    };

    for (const [imageName, imageInfo] of Object.entries(shan.images)) {
        if (!imageInfo) {
            continue; // That image does not exist for this Shan
        }

        var frames: AnimationFrames = {
            normal: {
                start: 0,
                length: shan.framesPer
            }
        }

        let blendMode = BLEND_MODES.NORMAL;
        if (imageName === "lightImage"
            || imageName === "glowImage"
            || imageName === "weapImage") {
            blendMode = BLEND_MODES.ADD;
        }

        switch (shan.flags.extraFramePurpose) {
            case ('banking'):
                frames.left = {
                    start: shan.framesPer,
                    length: shan.framesPer,
                }
                frames.right = {
                    start: shan.framesPer * 2,
                    length: shan.framesPer
                };
                break;
            case ('animation'):
                frames.animation = {
                    start: shan.framesPer,
                    // The rest of the frames are for the animation
                    length: shan.framesPer *
                        ((imageInfo.setCount || shan.images.baseImage.setCount) - 1)
                }
                break;
        }


        // get the rled from novadata
        // The rled contains the ID of the image that is used.
        var rled = shan.idSpace.rlëD[imageInfo.ID];
        if (!rled) {
            notFoundFunction(`shän id ${base.id} has no corresponding`
                + ` rlëD for ${imageName}, which expects`
                + ` rlëD id ${imageInfo.ID} to be available.`);

            if (imageName == "baseImage") { // Everything must have a baseImage.
                throw new NovaIDNotFoundError("Base image not found for rlëD id " + imageInfo.ID);
            }

            continue; // Don't add this as an image since it wasn't found. 
        }

        // Store the image in images
        images[imageName] = {
            id: rled.globalID,
            dataType: NovaDataType.SpriteSheetImage,
            blendMode,
            frames,
        };
    }

    return {
        ...base,
        images,
        exitPoints: shan.exitPoints,
        blink: blinkPattern(shan.blink),
    }
}

/**
 * Maps the shän resource's raw blink mode + BlinkValA-D into the named
 * `BlinkPattern` the display layer consumes. Returns null for steady lights.
 *
 * Note the errata swap for square-wave mode: BlinkValA is the on-time and
 * BlinkValB the between-blink off-time (the Bible's main text has these
 * reversed; the errata corrects them).
 */
export function blinkPattern(
    blink: ShanResource["blink"]): BlinkPattern | null {
    if (!blink) {
        return null;
    }
    switch (blink.mode) {
        case "square":
            return {
                mode: "square",
                onFrames: blink.a,
                offFrames: blink.b,
                blinksPerGroup: blink.c,
                groupDelayFrames: blink.d,
            };
        case "triangle":
            return {
                mode: "triangle",
                minIntensity: blink.a,
                riseRate: blink.b,
                maxIntensity: blink.c,
                fallRate: blink.d,
            };
        case "random":
            return {
                mode: "random",
                minIntensity: blink.a,
                maxIntensity: blink.b,
                changeDelayFrames: blink.c,
            };
        default:
            // "unknown" mode — treat as steady.
            return null;
    }
}
