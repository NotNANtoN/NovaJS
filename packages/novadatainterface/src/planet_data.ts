import { SpaceObjectData, getDefaultSpaceObjectData } from "./space_object_data.js";
import { DamageType } from "./weapon_data.js";

/** spöb Flags decoded to the named booleans the game uses. */
export interface PlanetFlags {
    /** Can land/dock here (0x1). */
    canLand: boolean;
    /** Has commodity exchange (0x2). */
    hasCommodityExchange: boolean;
    /** Can outfit ship here (0x4). */
    hasOutfitter: boolean;
    /** Can buy ships here (0x8). */
    hasShipyard: boolean;
    /** Stellar is a station instead of a planet (0x10). */
    isStation: boolean;
    /** Stellar is uninhabited (0x20). */
    uninhabited: boolean;
    /** Has a bar (0x40). */
    hasBar: boolean;
    /** Can only land here once the stellar is destroyed (0x80). */
    landOnlyIfDestroyed: boolean;
}

export interface PlanetData extends SpaceObjectData {
    landingPict: string;
    landingDesc: string;
    position: [number, number];
    /** Global id of the owning gövt, or null for independent. */
    govt: string | null;
    /** Named spöb flag booleans (landability, services, habitation). */
    flags: PlanetFlags;
    /** Tech level, controlling default outfit/ship availability. */
    techLevel: number;
}

export function getDefaultPlanetFlags(): PlanetFlags {
    return {
        canLand: true,
        hasCommodityExchange: false,
        hasOutfitter: true,
        hasShipyard: true,
        isStation: false,
        uninhabited: false,
        hasBar: true,
        landOnlyIfDestroyed: false,
    };
}

export function getDefaultPlanetData(): PlanetData {
    return {
        ...getDefaultSpaceObjectData(),
        vulnerableTo: <Array<DamageType>>["planetBuster"],
        landingPict: "default",
        landingDesc: "default",
        position: [0, 0],
        govt: null,
        flags: getDefaultPlanetFlags(),
        techLevel: 0,
    };
}
