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

/**
 * How a ship's EXTRA base sprite sets (beyond the first rotation set)
 * are used, decoded from the shän Flags word (EVN Bible pp. 15-16).
 * Present only for ships that use their extra sets for something other
 * than banking (banking stays expressed as the `left`/`right` frame
 * ranges the rotation path already consumes). Every base set is a full
 * `framesPer`-frame rotation set, so the displayed frame composes as
 * `setIndex * framesPer + rotationFrame` — the animation picks the
 * SET, the ship's heading picks the frame WITHIN it.
 *
 * Purpose (mutually exclusive, per the Bible):
 * - `continuous` (0x0008): the sets cycle in sequence on logical time,
 *   `setsPerSecond` sets per second, like the alt-image overlay. A
 *   spinning ring (Leviathan, Manticore).
 * - `folding` (0x0002): the sets are a fold/unfold sequence played on
 *   hyperspace entry/exit (and landing/takeoff). Set 0 is the folded
 *   rest pose; the last set is fully unfolded. The Argosy's expanding
 *   segments.
 * - `keyCarried` (0x0004): set 1 is shown instead of set 0 while the
 *   ship carries at least one of its KeyCarried outfit type.
 *
 * Display-only metadata (it rides on the shared, static Animation), EXCEPT
 * that a folding ship with `unfoldWhenFiring` (0x0080) gates weapon fire
 * on being fully unfolded — that fold progress is real simulation state
 * (see FoldStateComponent); this record only tells the engine the flag is
 * set and how fast to fold.
 */
export interface ShipAnimationMode {
    purpose: 'continuous' | 'folding' | 'keyCarried';
    /** Number of base sprite sets (each `framesPer` frames). */
    baseSetCount: number;
    /** Frames for one rotation, i.e. the size of one base set. */
    framesPer: number;
    /** Sets advanced per second (30 / AnimDelay). */
    setsPerSecond: number;
    /** shän 0x0080: a folding ship unfolds while firing and cannot fire
     * until fully unfolded (asteroid-miner claws). Only meaningful for
     * `folding`. */
    unfoldWhenFiring: boolean;
    /** shän 0x0010: freeze the animation while the ship is disabled. */
    stopWhenDisabled: boolean;
    /** shän 0x0020: hide the alt-image overlay while disabled. */
    hideAltWhenDisabled: boolean;
    /** shän 0x0040: hide the running lights while disabled. */
    hideLightsWhenDisabled: boolean;
}

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
    /**
     * How the ship's extra base sprite sets animate (continuous spin,
     * folding wings, key-carried appearance), or `null` when the ship has
     * only the plain rotation set (or uses its extra sets for banking).
     * See ShipAnimationMode.
     */
    animationMode: ShipAnimationMode | null;
}

export function getDefaultAnimation(): Animation {
    return {
        images: {
            baseImage: getDefaultAnimationImage()
        },
        exitPoints: getDefaultExitPoints(),
        blink: null,
        animationMode: null,
        ...getDefaultBaseData()
    }
}
