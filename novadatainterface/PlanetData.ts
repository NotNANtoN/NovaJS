import { SpaceObjectData, getDefaultSpaceObjectData } from "./SpaceObjectData";
import { DamageType } from "./WeaponData";

export interface PlanetData extends SpaceObjectData {
    landingPict: string;
    landingDesc: string;
    position: [number, number];
    /** Raw government ID; -1 means independent. */
    government?: number;
    /** Derived from the spöb uninhabited flag. */
    inhabited?: boolean;
}

export function getDefaultPlanetData(): PlanetData {
    return {
        ...getDefaultSpaceObjectData(),
        vulnerableTo: <Array<DamageType>>["planetBuster"],
        landingPict: "default",
        landingDesc: "default",
        position: [0, 0],
        government: -1,
        inhabited: true,
    };
}
