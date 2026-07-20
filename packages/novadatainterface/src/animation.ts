import { BLEND_MODES } from "./blend_modes.js";
import { BaseData, getDefaultBaseData } from "./base_data.js";
import { NovaDataType } from "./nova_data_interface.js";


export interface AnimationImageIndex {
    start: number;
    length: number;
}

export function getDefaultAnimationImageIndex() {
    return { start: 0, length: 1 };
}

export type AnimationFrames = {
    [index: string]: AnimationImageIndex,
    normal: AnimationImageIndex,
} & {
    left?: AnimationImageIndex,
    right?: AnimationImageIndex,
}

export function getDefaultAnimationFrames(): AnimationFrames {
    return {
        normal: getDefaultAnimationImageIndex()
    };
}

export interface AnimationImage {
    id: string;
    // TODO: Add a datatype for using picts here.
    dataType: NovaDataType.SpriteSheetImage;
    blendMode: BLEND_MODES;
    frames: AnimationFrames;
}

export function getDefaultAnimationImage(): AnimationImage {
    return {
        id: "default",
        dataType: NovaDataType.SpriteSheetImage,
        blendMode: BLEND_MODES.NORMAL,
        frames: getDefaultAnimationFrames()
    };
}

export type AnimationImages = {
    [index: string]: AnimationImage,
    baseImage: AnimationImage
}

/**
 * How a ship's running-light sprite layer flashes, from the shän resource's
 * BlinkMode / BlinkValA-D fields (EVN Bible pp. 15). Display-only.
 *
 * All timings (`period`, on/off durations, delays) are in animation frames,
 * i.e. 30ths of a second, matching Nova's other shän timing fields.
 *
 * - `square`: on/off strobe grouped into bursts. `onFrames` on, `offFrames`
 *   off, repeated `blinksPerGroup` times, then `groupDelayFrames` off before
 *   the next group. (Per the Bible's errata, BlinkValA is the on-time and
 *   BlinkValB the between-blink off-time — swapped from the main text.)
 * - `triangle`: intensity ramps linearly up from `minIntensity` to
 *   `maxIntensity` (increasing `riseRate`/frame) then back down
 *   (`fallRate`/frame). Intensities are 1-32, mapped to sprite alpha.
 * - `random`: intensity jumps to a fresh random value in
 *   [`minIntensity`, `maxIntensity`] every `changeDelayFrames` frames.
 */
export type BlinkPattern =
    | {
        mode: "square";
        onFrames: number;
        offFrames: number;
        blinksPerGroup: number;
        groupDelayFrames: number;
    }
    | {
        mode: "triangle";
        minIntensity: number;
        riseRate: number;
        maxIntensity: number;
        fallRate: number;
    }
    | {
        mode: "random";
        minIntensity: number;
        maxIntensity: number;
        changeDelayFrames: number;
    };

export type ExitPoint = Array<[number, number, number]>;
export interface ExitPoints {
    gun: ExitPoint;
    turret: ExitPoint;
    guided: ExitPoint;
    beam: ExitPoint;
    upCompress: [number, number];
    downCompress: [number, number];
};

export function getDefaultExitPoints(): ExitPoints {
    return {
        gun: [],
        turret: [],
        guided: [],
        beam: [],
        upCompress: [0, 0],
        downCompress: [0, 0]
    }
}

// This probably actually shouldn't extend BaseData
export interface Animation extends BaseData {
    images: AnimationImages;
    exitPoints: ExitPoints;
    /**
     * How the running-lights sprite layer flashes, or `null` for a steady
     * (non-blinking) light. Display-only; has no effect on simulation.
     */
    blink: BlinkPattern | null;
}

export function getDefaultAnimation(): Animation {
    return {
        images: {
            baseImage: getDefaultAnimationImage()
        },
        exitPoints: getDefaultExitPoints(),
        blink: null,
        ...getDefaultBaseData()
    }
}
