import { SpaceObjectData, getDefaultSpaceObjectData } from "./SpaceObjectData";
import { DamageType } from "./WeaponData";
import { TradeCommodity } from "./CommodityData";

export interface PlanetData extends SpaceObjectData {
    landingPict: string;
    hasCustomLandingPict: boolean;
    landingDesc: string;
    position: [number, number];
    /** Raw spöb flags controlling landing and spaceport services. */
    flags?: number;
    /** The base technology level offered at this stellar. */
    techLevel?: number;
    /** Special technology levels offered at this stellar. */
    specialTech?: number[];
    /** The spöb 0x1 landing/docking flag. */
    canLand?: boolean;
    /** Raw government ID; -1 means independent. */
    government?: number;
    /** Derived from the spöb uninhabited flag. */
    inhabited?: boolean;
    hasCommodityExchange?: boolean;
    hasOutfitter?: boolean;
    hasShipyard?: boolean;
    hasBar?: boolean;
    /** Generic commodities available at this stellar and their price levels. */
    /** Tribute paid per day when dominated (EV Nova Bible, spöb/Tribute). */
    tribute?: number;
    tradeCommodities: TradeCommodity[];
}

export function getDefaultPlanetData(): PlanetData {
    return {
        ...getDefaultSpaceObjectData(),
        vulnerableTo: <Array<DamageType>>["planetBuster"],
        landingPict: "default",
        hasCustomLandingPict: false,
        landingDesc: "default",
        position: [0, 0],
        // Leave raw flags unknown for synthetic/default data. Parsed spöbs
        // always provide them, while the derived defaults preserve the
        // pre-flags behavior of mock data.
        flags: undefined,
        techLevel: undefined,
        specialTech: [],
        canLand: true,
        government: -1,
        inhabited: true,
        hasCommodityExchange: true,
        hasOutfitter: true,
        hasShipyard: true,
        hasBar: true,
        tradeCommodities: [],
    };
}
