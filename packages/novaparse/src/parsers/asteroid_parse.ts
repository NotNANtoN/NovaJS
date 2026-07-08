import { Animation, AnimationImage, getDefaultAnimationImage, getDefaultExitPoints } from "novadatainterface/animation";
import { AsteroidData } from "novadatainterface/asteroid_data";
import { BaseData } from "novadatainterface/base_data";
import { NovaDataType } from "novadatainterface/nova_data_interface";
import { BLEND_MODES } from "novadatainterface/blend_modes";
import { RoidResource } from "../resource_parsers/roid_resource.js";
import { NovaResources } from "../resource_parsers/resource_holder_base.js";
import { BaseParse } from "./base_parse.js";

/** röid 128 uses spïn 800, röid 129 spïn 801, etc. (EVN Bible p. 13). */
const ASTEROID_SPIN_OFFSET = 800 - 128;

function animationFromSpin(idSpace: NovaResources, spinId: number,
    base: BaseData, notFoundFunction: (m: string) => void): Animation {
    let animationImage: AnimationImage = getDefaultAnimationImage();
    const spin = idSpace.spïn[spinId];
    if (spin) {
        const rled = spin.idSpace.rlëD[spin.spriteID];
        if (rled) {
            animationImage = {
                id: rled.globalID,
                dataType: NovaDataType.SpriteSheetImage,
                blendMode: BLEND_MODES.NORMAL,
                frames: {
                    normal: { start: 0, length: rled.numberOfFrames }
                }
            };
        } else {
            notFoundFunction("Missing rlëD " + spin.spriteID
                + " for spïn " + spinId + " used by röid " + base.id);
        }
    } else {
        notFoundFunction("Missing spïn " + spinId + " for röid " + base.id);
    }

    return {
        ...base,
        images: { baseImage: animationImage },
        exitPoints: getDefaultExitPoints(),
    };
}

export async function AsteroidParse(roid: RoidResource,
    notFoundFunction: (m: string) => void): Promise<AsteroidData> {
    const base: BaseData = await BaseParse(roid, notFoundFunction);

    const animation = animationFromSpin(roid.idSpace,
        roid.id + ASTEROID_SPIN_OFFSET, base, notFoundFunction);

    // Resolve what an ejected resource-box contains. 0-5 is a standard
    // cargo type; 1000-1127 is jünk resource 128-255.
    let yieldType: string | null = null;
    if (roid.yieldType >= 0 && roid.yieldType <= 5) {
        yieldType = `cargo:${roid.yieldType}`;
    } else if (roid.yieldType >= 1000) {
        const junkId = roid.yieldType - 1000 + 128;
        const junk = roid.idSpace.jünk[junkId];
        if (junk) {
            yieldType = `junk:${junk.globalID}`;
        } else {
            notFoundFunction("Missing jünk " + junkId + " for röid " + base.id);
            yieldType = `junk:${junkId}`;
        }
    }

    // Resource-boxes look like scaled-down chunks of the asteroid that
    // broke, matching the original engine's look. (The Bible's
    // dedicated resource-box sprites — cargo box spïn 500 and
    // mini-asteroids 501-504 — are 8x8 pixels: imperceptible specks in
    // game.) The display applies the down-scale; the distinct id keeps
    // the display's graphic pools separate per debris type.
    let debrisAnimation: Animation | null = null;
    if (yieldType !== null) {
        debrisAnimation = {
            ...animation,
            id: `${base.id} debris`,
            name: `${base.name} debris`,
        };
    }

    // Sub-asteroid types, resolved to global ids.
    const fragments: string[] = [];
    for (const fragId of roid.fragTypes) {
        const frag = roid.idSpace.röid[fragId];
        if (frag) {
            fragments.push(frag.globalID);
        } else {
            notFoundFunction("Missing röid " + fragId
                + " for fragment of röid " + base.id);
        }
    }

    // ExplodeType 0-63 maps to bööm 128-191; 1000+ additionally shows
    // sparks (same encoding as wëap ExplodeType). -1 for none.
    let explosion: string | null = null;
    if (roid.explodeType >= 0) {
        const boomId = (roid.explodeType % 1000) + 128;
        const boom = roid.idSpace.bööm[boomId];
        if (boom) {
            explosion = boom.globalID;
        } else {
            notFoundFunction("Missing bööm " + boomId + " for röid " + base.id);
        }
    }

    return {
        ...base,
        animation,
        strength: roid.strength,
        // SpinRate 100 = 30 frames per second.
        frameRate: roid.spinRate * 30 / 100,
        yieldType,
        yieldQuantity: roid.yieldQuantity,
        debrisAnimation,
        fragments,
        fragmentCount: Math.max(0, roid.fragCount),
        explosion,
        particles: {
            count: roid.particleCount,
            color: roid.particleColor,
        },
        mass: roid.mass,
    };
}
