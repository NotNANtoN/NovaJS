import {
    Animation,
    getDefaultAnimationImage,
    getDefaultExitPoints,
} from "novadatainterface/Animation";
import { AsteroidData, AsteroidYield } from "novadatainterface/AsteroidData";
import { BaseData } from "novadatainterface/BaseData";
import { BLEND_MODES } from "novadatainterface/BlendModes";
import { NovaDataType } from "novadatainterface/NovaDataInterface";
import { RoidResource } from "../resource_parsers/RoidResource";
import { BaseParse } from "./BaseParse";
import { standardCargoNames } from "./MissionParse";

/** Yield types at or above this value select a jünk resource. */
const JUNK_YIELD_BASE = 1000;

/**
 * Asteroid and ore sheets are 6x6 tile spins. The tumble is driven by the
 * entity's rotation, so the whole sheet is one rotational frame set, just
 * like a ship's.
 */
const ASTEROID_FRAMES = 36;

/**
 * Names the cargo an asteroid drops. Standard commodities are named by the
 * shared table. jünk resources are not parsed, so a junk yield is named after
 * the asteroid's material, which is how retail's asteroid families read
 * ("Ice Small" drops ice).
 */
export function asteroidYieldCommodity(
    yieldType: number, asteroidName: string,
): string | undefined {
    if (yieldType < 0) {
        return undefined;
    }
    if (yieldType < standardCargoNames.length) {
        return standardCargoNames[yieldType];
    }
    if (yieldType >= JUNK_YIELD_BASE) {
        const material = asteroidName.trim().split(/\s+/)[0];
        return material ? material.toLowerCase() : undefined;
    }
    return undefined;
}

export async function AsteroidParse(
    roid: RoidResource,
    notFoundFunction: (message: string) => void,
): Promise<AsteroidData> {
    const base: BaseData = await BaseParse(roid, notFoundFunction);

    const spriteSheetFor = (spinID: number): string => {
        const spin = roid.idSpace.spïn[spinID];
        if (!spin) {
            notFoundFunction(
                `No matching spïn ${spinID} for röid of id ${base.id}`);
            return getDefaultAnimationImage().id;
        }
        const rled = roid.idSpace.rlëD[spin.spriteID];
        if (!rled) {
            notFoundFunction(`No matching rlëD ${spin.spriteID} for röid `
                + `of id ${base.id}`);
            return getDefaultAnimationImage().id;
        }
        return rled.globalID;
    };

    const animationFor = (spinID: number): Animation => ({
        exitPoints: getDefaultExitPoints(),
        id: base.id,
        name: base.name,
        prefix: base.prefix,
        images: {
            baseImage: {
                id: spriteSheetFor(spinID),
                dataType: NovaDataType.SpriteSheetImage,
                blendMode: BLEND_MODES.NORMAL,
                rotateInPlane: false,
                frames: {
                    normal: { start: 0, length: ASTEROID_FRAMES },
                },
            },
        },
    });

    const quantity = Math.max(0, roid.yieldQuantity);
    const commodity = asteroidYieldCommodity(roid.yieldType, base.name);
    const asteroidYield: AsteroidYield = commodity && quantity > 0
        ? { commodity, quantity }
        : { quantity: 0 };

    return {
        ...base,
        strength: Math.max(1, roid.strength),
        prevalence: Math.max(0, roid.prevalence),
        yield: asteroidYield,
        fragments: roid.fragmentTypes
            .filter(id => id >= 128)
            .map(id => roid.idSpace.röid[id]?.globalID)
            .filter((id): id is string => typeof id === 'string'),
        fragmentCount: Math.max(0, roid.fragmentCount),
        sizeClass: Math.max(0, roid.sizeClass),
        mass: Math.max(1, roid.mass),
        color: roid.color,
        animation: animationFor(roid.spinID),
        yieldAnimation: animationFor(roid.mineralSpinID),
    };
}
