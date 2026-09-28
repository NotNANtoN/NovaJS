import { SpaceObjectData, getDefaultSpaceObjectData } from "./SpaceObjectData";
import { Animation } from "./Animation";
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
    /** Ambient landscape sound played while landed (spöb CustSndID). */
    ambientSound?: string;
    /** spöb control-bit set expressions (EV Nova Bible, spöb resource). */
    onDominate?: string;
    onRelease?: string;
    onDestroy?: string;
    onRegen?: string;
    /** spöb Flags2 (0x0040: starts the game destroyed). */
    flags2?: number;
    /**
     * Combined mass and energy damage from planet-type weapons before the
     * stellar is destroyed; 0 or -1 means invincible (EV Nova Bible).
     */
    strength?: number;
    /** Stellar graphic shown while destroyed, -1 to hide the stellar. */
    deadType?: number;
    /** Days destroyed: 0 regenerates at the end of the day, -1 never. */
    deadTime?: number;
    /** Explosion type 0-63, 1000+ adds extra explosions, -1 none. */
    explodType?: number;
    /** The DeadType stellar graphic, when it resolves to a sprite. */
    deadAnimation?: Animation;
    /** bööm for ExplodType (type 0-63 is bööm 128-191). */
    explosion?: string;
    /** ExplodType 1000+: the type-0 bööm scattered around the main one. */
    secondaryExplosion?: string;
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
