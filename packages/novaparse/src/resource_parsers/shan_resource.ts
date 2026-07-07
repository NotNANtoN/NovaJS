import { Resource } from "resource_fork";
import { ExitPoint, ExitPoints } from "novadatainterface/animation";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

type ImageInfo = {
    ID: number,
    maskID: number,
    setCount: number,
    size: Array<number>,
    transparency: number;
};

type Flags = {
    extraFramePurpose: string,
    displayEngineGlowWhenTurning: boolean,
    stopAnimationWhenDisabled: boolean,
    hideAltSpritesWhenDisabled: boolean,
    hideLightsWhenDisabled: boolean,
    unfoldWhenFiring: boolean,
    adjustForOffset: boolean
};

type Blink = {
    mode: string,
    a: number,
    b: number,
    c: number,
    d: number
};

type ShanImages = {
    [index: string]: ImageInfo | null,
    baseImage: ImageInfo, // All Shans must have a base image
    altImage: ImageInfo | null,
    glowImage: ImageInfo | null,
    lightImage: ImageInfo | null,
    weapImage: ImageInfo | null,
    shieldImage: ImageInfo | null
};

/**
 * A ship animation: which rlëD sprites make up a ship (base, engine glow,
 * running lights, etc.), how they animate, and where weapons exit the ship.
 *
 * Field layout follows ResForge's shän template (192 bytes, matching Nova's
 * own data exactly), documented in the EVN Bible pp. 14-16.
 */
class ShanResource extends BaseResource {
    images: ShanImages;
    flags: Flags;
    /** Frames between animation frames (30ths of a second). */
    animDelay: number;
    /** Frames for the weapon glow to fade out. */
    weapDecay: number;
    /** Sprite frames per rotation. */
    framesPer: number;
    blink: Blink | null;
    exitPoints: ExitPoints;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        // Sprite id, mask id, and frame size; setCount only for base/alt.
        const image = (hasSetCount: boolean): ImageInfo | null => {
            const info: ImageInfo = {
                ID: r.int16(-1),
                maskID: r.int16(-1),
                setCount: hasSetCount ? r.int16() : 0,
                size: [r.int16(), r.int16()],
                transparency: 0,
            };
            return info.ID <= 0 ? null : info;
        };

        const baseImage = image(true);
        if (!baseImage) {
            throw new Error("Required image was null");
        }
        baseImage.transparency = r.int16();

        this.images = {
            baseImage,
            altImage: image(true),
            glowImage: image(false),
            lightImage: image(false),
            weapImage: image(false),
            shieldImage: null,  // Stored later in the resource, at offset 64.
        };

        const flagN = r.uint16();
        this.flags = {
            extraFramePurpose: "unknown",
            displayEngineGlowWhenTurning: false,
            stopAnimationWhenDisabled: (flagN & 0x10) > 0,
            hideAltSpritesWhenDisabled: (flagN & 0x20) > 0,
            hideLightsWhenDisabled: (flagN & 0x40) > 0,
            unfoldWhenFiring: (flagN & 0x80) > 0,
            adjustForOffset: (flagN & 0x100) > 0,
        };
        if (flagN & 0x1)
            this.flags.extraFramePurpose = "banking";
        if (flagN & 0x2)
            this.flags.extraFramePurpose = "folding";
        if (flagN & 0x4)
            this.flags.extraFramePurpose = "keyCarried";
        if (flagN & 0x8)
            this.flags.extraFramePurpose = "animation";
        if ((flagN & 0x3) == 3) {
            this.flags.extraFramePurpose = "banking";
            this.flags.displayEngineGlowWhenTurning = true;
        }

        this.animDelay = r.int16();
        this.weapDecay = r.int16();
        this.framesPer = r.int16();

        // The meaning of the four params depends on the blink mode.
        const blinkMode = r.int16();
        const blinkParams = r.array(4, () => r.int16());
        this.blink = null;
        if (blinkMode !== -1 && blinkMode !== 0) {
            const modes: { [index: number]: string } = {
                1: "square", 2: "triangle", 3: "random",
            };
            this.blink = {
                mode: modes[blinkMode] ?? "unknown",
                a: blinkParams[0],
                b: blinkParams[1],
                c: blinkParams[2],
                d: blinkParams[3],
            };
        }

        this.images.shieldImage = image(false);

        // Weapon exit points: parallel 4-element x and y arrays per type,
        // with the z arrays all the way at the end of the resource.
        const xy: { [index: string]: { x: number[], y: number[] } } = {};
        for (const type of ["gun", "turret", "guided", "beam"]) {
            xy[type] = {
                x: r.array(4, () => r.int16()),
                y: r.array(4, () => r.int16()),
            };
        }

        // upCompress and downCompress values are assumed to be 100 if 0.
        const upCompress: [number, number] =
            [r.int16() || 100, r.int16() || 100];
        const downCompress: [number, number] =
            [r.int16() || 100, r.int16() || 100];

        const exitPoint = (type: string): ExitPoint => {
            const z = r.array(4, () => r.int16());
            const points: ExitPoint = [];
            for (let i = 0; i < 4; i++) {
                points.push([xy[type].x[i], xy[type].y[i], z[i]]);
            }
            return points;
        };
        this.exitPoints = {
            gun: exitPoint("gun"),
            turret: exitPoint("turret"),
            guided: exitPoint("guided"),
            beam: exitPoint("beam"),
            upCompress,
            downCompress,
        };
    }
}

export { ShanResource };
