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
/** The cargo box sprite for standard-cargo resource-boxes. */
const CARGO_BOX_SPIN = 500;
/** Mini-asteroid sprites for jünk resource-boxes (spïn 501-504). */
const MINERAL_SPIN_START = 501;
const MINERAL_SPIN_COUNT = 4;

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
        blink: null, // Asteroids have no running lights.
        animationMode: null, // Asteroid tumble is a röid SpinRate, not shän.
        weapDecay: 0, // No weapon overlay outside shän ships.
    };
}

export async function AsteroidParse(roid: RoidResource,
    notFoundFunction: (m: string) => void): Promise<AsteroidData> {
    const base: BaseData = await BaseParse(roid, notFoundFunction);

    const animation = animationFromSpin(roid.idSpace,
        roid.id + ASTEROID_SPIN_OFFSET, base, notFoundFunction);

    // Resolve what an ejected resource-box contains. 0-5 is a standard
    // cargo type; 1000-1127 is jünk resource 128-255. Boxes use the
    // engine-specified sprites: the cargo box (spïn 500) for standard
    // cargo, a mini-asteroid (spïn 501-504) for jünk. Note the source
    // art really is 8x8 pixels per frame — the rlëD headers (500-508)
    // declare 8x8, matching the spïn declarations — so the display
    // scales boxes up to be visible (see asteroid_display_plugin.ts).
    let yieldType: string | null = null;
    let debrisSpin: number | null = null;
    if (roid.yieldType >= 0 && roid.yieldType <= 5) {
        yieldType = `cargo:${roid.yieldType}`;
        debrisSpin = CARGO_BOX_SPIN;
    } else if (roid.yieldType >= 1000) {
        const junkId = roid.yieldType - 1000 + 128;
        const junk = roid.idSpace.jünk[junkId];
        if (junk) {
            yieldType = `junk:${junk.globalID}`;
        } else {
            notFoundFunction("Missing jünk " + junkId + " for röid " + base.id);
            yieldType = `junk:${junkId}`;
        }
        debrisSpin = MINERAL_SPIN_START
            + (roid.yieldType - 1000) % MINERAL_SPIN_COUNT;
    }

    let debrisAnimation: Animation | null = null;
    if (debrisSpin !== null) {
        debrisAnimation = animationFromSpin(roid.idSpace, debrisSpin,
            { ...base, id: `${base.id} debris` }, notFoundFunction);
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
