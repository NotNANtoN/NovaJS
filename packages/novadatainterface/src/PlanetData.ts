import { SpaceObjectData, getDefaultSpaceObjectData } from "./SpaceObjectData.js";
import { DamageType } from "./WeaponData.js";

export interface PlanetData extends SpaceObjectData {
    landingPict: string;
    landingDesc: string;
    position: [number, number];
}

export function getDefaultPlanetData(): PlanetData {
    return {
        ...getDefaultSpaceObjectData(),
        vulnerableTo: <Array<DamageType>>["planetBuster"],
        landingPict: "default",
        landingDesc: "default",
        position: [0, 0]
    };
}
