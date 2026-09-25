import { Animation, AnimationFrames, AnimationImages, getDefaultAnimationImage } from "novadatainterface/Animation";
import { BaseData } from "novadatainterface/BaseData";
import { NovaDataType } from "novadatainterface/NovaDataInterface";
import { NovaIDNotFoundError } from "novadatainterface/NovaDataInterface";
import { BLEND_MODES } from "novadatainterface/BlendModes";
import { ShanResource } from "../resource_parsers/ShanResource";
import { BaseParse } from "./BaseParse";

/**
 * Hulls whose frames must not be rotated in-plane between pre-rendered
 * headings. Measured from the retail sprites: the Pegasus is a lit saucer
 * (in-plane rotation turns its lighting, which snaps back each frame) and the
 * Leviathan's 64 perspective frames are unevenly spaced by up to 23 degrees,
 * so interpolating between them overshoots and jumps back.
 */
const SNAP_ROTATION_BASE_SPRITES = new Set([
    1006, // Leviathan (shän 131, 190, 192)
    1008, // Pegasus (shän 132, 193, 194, 365, 366, 377)
]);

export async function ShanParse(shan: ShanResource, notFoundFunction: (message: string) => void): Promise<Animation> {
    var base: BaseData = await BaseParse(shan, notFoundFunction);

    var images: AnimationImages = {
        baseImage: getDefaultAnimationImage()
    };

    // Keyed on the artwork, not the hull: several shäns reuse one sprite.
    const snapRotation = SNAP_ROTATION_BASE_SPRITES.has(shan.images.baseImage?.ID ?? -1);

    for (const [imageName, imageInfo] of Object.entries(shan.images)) {
        if (!imageInfo) {
            continue; // That image does not exist for this Shan
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

        var frames: AnimationFrames = {
            normal: {
                start: 0,
                length: shan.framesPer
            }
        };

        let blendMode = BLEND_MODES.NORMAL;
        if (imageName === "lightImage"
            || imageName === "glowImage"
            || imageName === "weapImage"
            || imageName === "shieldImage") {
            blendMode = BLEND_MODES.ADD;
        }

        if (shan.flags.extraFramePurpose === "banking" && rled.numberOfFrames >= shan.framesPer * 3) {
            frames.left = {
                start: shan.framesPer,
                length: shan.framesPer,
            };
            frames.right = {
                start: shan.framesPer * 2,
                length: shan.framesPer,
            };
        } else if (shan.flags.extraFramePurpose === "animation" && rled.numberOfFrames > shan.framesPer) {
            frames.animation = {
                start: shan.framesPer,
                length: rled.numberOfFrames - shan.framesPer,
            };
        }

        // Store the image in images
        images[imageName] = {
            id: rled.globalID,
            dataType: NovaDataType.SpriteSheetImage,
            blendMode,
            frames,
            ...(snapRotation ? { snapRotation: true } : {}),
        };
    }

    return {
        ...base,
        images,
        exitPoints: shan.exitPoints
    };
}
