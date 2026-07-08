import { BaseData } from "novadatainterface/base_data";
import { BaseParse } from "./base_parse.js";
import { SpriteSheetData, SpriteSheetFramesData, SpriteSheetImageData, Hull, FrameInfo, ConvexHull, DefaultImageLocation, getDefaultConvexHull } from "novadatainterface/sprite_sheet_data";
import { RledResource } from "../resource_parsers/rled_resource.js";
import { PNG } from "pngjs";
import * as path from "path";
import hull from 'hull.js';
import { bufferToArrayBuffer } from "./buffer_to_array_buffer.js";
import { decomposePolygon, Point } from "../hull/convex_decomposition.js";
import { simplifyPolygon, traceOutline } from "../hull/trace_outline.js";


export interface SpriteSheetMulti {
    spriteSheet: SpriteSheetData;
    spriteSheetImage: SpriteSheetImageData;
    spriteSheetFrames: SpriteSheetFramesData;
}

const SHEET_LOOP = 10;

class DimensionError extends Error { };

function getWH(frames: Array<PNG>): { singleFrameWidth: number, singleFrameHeight: number, fullPixelWidth: number, fullPixelHeight: number } {
    var singleFrameWidth = frames[0].width;
    var singleFrameHeight = frames[0].width;

    var fullPixelWidth: number = Math.min(SHEET_LOOP, frames.length) * singleFrameWidth;
    var fullPixelHeight: number = Math.ceil(frames.length / SHEET_LOOP) * singleFrameHeight;

    return {
        fullPixelHeight,
        fullPixelWidth,
        singleFrameHeight,
        singleFrameWidth
    }
}

function buildPNG(frames: Array<PNG>): PNG {
    var { fullPixelHeight, fullPixelWidth, singleFrameHeight, singleFrameWidth } = getWH(frames);

    var outPNG = new PNG({
        filterType: 4,
        width: fullPixelWidth,
        height: fullPixelHeight
    });

    for (let f = 0; f < frames.length; f++) {
        let frame = frames[f];

        // Validation for sanity
        // if (frame.width != singleFrameWidth || frame.height != singleFrameHeight) {
        //     throw new DimensionError("Wrong dimensions " + frame.width + " by " + frame.height
        //         + ". Expected " + singleFrameWidth + " by " + singleFrameHeight + ".");
        // }

        var col = f % SHEET_LOOP;
        var row = Math.floor(f / SHEET_LOOP);

        for (var y = 0; y < frame.height; y++) {
            for (var x = 0; x < frame.width; x++) {
                var frameIDX = (frame.width * y + x) << 2;

                var pngIDX = (outPNG.width * y +       // skip to next row of pixels

                    outPNG.width *           // skip to next row of frames
                    singleFrameHeight * row +

                    x +                         // skip to next col of pixels
                    singleFrameWidth * col       // skip to next col of frames
                ) << 2;

                outPNG.data[pngIDX] = frame.data[frameIDX];
                outPNG.data[pngIDX + 1] = frame.data[frameIDX + 1];
                outPNG.data[pngIDX + 2] = frame.data[frameIDX + 2];
                outPNG.data[pngIDX + 3] = frame.data[frameIDX + 3];
                // is there a better way?
            }
        }
    }

    return outPNG;
}


// Includes in its output any points that are not black
function makeVisibleArray(png: PNG): Array<[number, number]> {
    var visibleArray: Array<[number, number]> = [];

    var origin = [png.width / 2, png.height / 2];

    for (var y = 0; y < png.height; y++) {
        for (var x = 0; x < png.width; x++) {
            var idx = (png.width * y + x) << 2;
            if (png.data[idx + 3] === 255) {
                visibleArray.push([x - origin[0], -(y - origin[1])]);
            }

        }
    }
    return visibleArray;
}

function makeConvexHull(png: PNG): ConvexHull {
    // No concavity. Convex hull.
    var visibleArray = makeVisibleArray(png);
    // TODO: Maybe replace this with rust's fast convex hull
    var hullWithRepeat = hull(visibleArray, Infinity) as ConvexHull;
    // If the hull is empty, return the default conved hull instead.
    if (hullWithRepeat.length === 0 || hullWithRepeat[0] === undefined) {
        return getDefaultConvexHull();
    }
    // Cut off the last point since it's the same as the first.
    return hullWithRepeat.slice(0, hullWithRepeat.length - 1);
}

// Simplification tolerance for the traced pixel outline, in pixels.
const OUTLINE_SIMPLIFY_EPSILON = 1;
// A component may be dented by up to this fraction of the sprite's size
// (with a floor in pixels) before it gets split further.
const CONCAVITY_TOLERANCE_RATIO = 0.05;
const MIN_CONCAVITY_TOLERANCE = 3;
// Keep hitboxes cheap: SAT tests each pair of convex components.
const MAX_HULL_COMPONENTS = 8;

// Approximate convex decomposition (Lien & Amato) of the sprite's pixel
// outline, so concave ships get a hull per protrusion instead of one
// convex hull spanning their notches. Purely deterministic in the sprite
// data; collision geometry must match across clients.
function makeHull(png: PNG): Hull {
    const outline = traceOutline({
        width: png.width,
        height: png.height,
        isFilled: (x, y) => x >= 0 && x < png.width && y >= 0 && y < png.height
            && png.data[(png.width * y + x) * 4 + 3] === 255,
    });
    if (outline) {
        // Same centered, y-up frame as makeVisibleArray.
        const centered = outline.map(([x, y]): Point =>
            [x - png.width / 2, -(y - png.height / 2)]);
        const simplified = simplifyPolygon(centered, OUTLINE_SIMPLIFY_EPSILON);
        const tolerance = Math.max(MIN_CONCAVITY_TOLERANCE,
            Math.max(png.width, png.height) * CONCAVITY_TOLERANCE_RATIO);
        const components = decomposePolygon(
            simplified, tolerance, MAX_HULL_COMPONENTS);
        if (components.length > 0) {
            return components;
        }
    }
    return [makeConvexHull(png)];
}

function buildSpriteSheetFrames(rled: RledResource): SpriteSheetFramesData {
    var frames = rled.frames;
    var { fullPixelHeight, fullPixelWidth, singleFrameHeight, singleFrameWidth } = getWH(frames);

    var imagePath = path.join(DefaultImageLocation, rled.globalID + ".png");

    var meta = {
        format: "RGBA8888",
        size: {
            w: fullPixelWidth,
            h: fullPixelHeight
        },
        scale: "1",
        image: imagePath
    }

    var frameInfoObj: { [index: string]: FrameInfo } = {};

    for (var f = 0; f < frames.length; f++) {
        var col = f % SHEET_LOOP;
        var row = Math.floor(f / SHEET_LOOP);

        frameInfoObj[rled.globalID + " " + f + ".png"] = {
            frame: {
                x: col * singleFrameWidth,
                y: row * singleFrameHeight,
                w: singleFrameWidth,
                h: singleFrameHeight
            },
            rotated: false,
            trimmed: false,
            sourceSize: { w: fullPixelWidth, h: fullPixelHeight }
        };
    }

    return {
        frames: frameInfoObj,
        meta
    }
}



// Parses SpriteSheet, SpriteSheetImage, and SpriteSheetFrames at the same time
// They are separated from each other due to PIXI.js peculiarities.
export async function SpriteSheetMultiParse(rled: RledResource, notFoundFunction: (m: string) => void): Promise<SpriteSheetMulti> {
    const base: BaseData = await BaseParse(rled, notFoundFunction);

    const assembledPNG: PNG = buildPNG(rled.frames);
    const buf = PNG.sync.write(assembledPNG);
    const spriteSheetImage = bufferToArrayBuffer(buf);

    const spriteSheet: SpriteSheetData = {
        ...base,
        hulls: rled.frames.map(makeHull),
    }

    const spriteSheetFrames = buildSpriteSheetFrames(rled);

    return {
        spriteSheet,
        spriteSheetImage,
        spriteSheetFrames
    };
};
