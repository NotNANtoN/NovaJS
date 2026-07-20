import { BaseData, getDefaultBaseData } from "./base_data.js";

/**
 * Which systems a përs may be created in (the përs LinkSyst field,
 * resolved to a discriminated union at parse time like the flët
 * LinkSyst). The Bible's ranges: -1 any system; 128-2175 a specific
 * sÿst; 9999 independent systems; 10000-10255 a govt's systems;
 * 15000-15255 a govt's allies' systems; 20000-20255 any but a govt's
 * systems; 25000-25255 a govt's enemies' systems.
 */
export type PersLinkSyst =
    { type: 'any' }
    | { type: 'system', id: string }
    | { type: 'independentSystems' }
    | { type: 'govtSystems', govt: string }
    | { type: 'allySystems', govt: string }
    | { type: 'notGovtSystems', govt: string }
    | { type: 'enemySystems', govt: string };

/**
 * A weapon added to (or removed from) the përs ship's stock loadout.
 * A negative count removes that many of the ship's standard weapons.
 */
export interface PersWeapon {
    /** Global wëap id. */
    id: string;
    count: number;
    /** Rounds of ammunition; -1/0 for weapons that need none. */
    ammo: number;
}

/** përs Flags decoded to named booleans (see the EVN Bible pp. 47-49). */
export interface PersFlags {
    /** Holds a grudge if attacked; attacks the player on sight after. */
    keepsGrudge: boolean;
    usesEscapePodAndAfterburner: boolean;
    hailOnlyWithGrudge: boolean;
    hailOnlyWhenLikesPlayer: boolean;
    hailOnlyWhenAttacking: boolean;
    hailOnlyWhenDisabled: boolean;
    /**
     * When its LinkMission (with a single special ship) is accepted,
     * the special ship replaces this përs ship in place.
     */
    replaceWithSpecialShip: boolean;
    hailOnlyOnce: boolean;
    /** Don't spawn again after its LinkMission is accepted. */
    deactivateAfterMission: boolean;
    /** Offer the LinkMission when boarding instead of when hailing. */
    offerMissionOnBoarding: boolean;
    hailOnlyWhenMissionAvailable: boolean;
    leavesAfterMissionAccepted: boolean;
    noMissionIfWimpyTrader: boolean;
    noMissionIfBeefyTrader: boolean;
    noMissionIfWarship: boolean;
    showDisasterInfoWhenHailing: boolean;
}

/**
 * A unique person ("përs"): a named AI personality. The person's name
 * (the resource name) is shown on the target-info display in place of
 * the ship class name. Per the Bible, when a ship is created there is
 * a 5% chance a specific AI-person is also created (in a system
 * matching its LinkSyst); a killed person ceases to appear.
 *
 * Field semantics follow the EVN Bible's përs section (pp. 47-49).
 * The boarding/hailing behaviors (LinkMission offers, hail quotes,
 * boarding grants) are carried as data; the engine implements what it
 * can (spawning, name display) and leaves the rest as documented
 * hooks until hailing/boarding exist.
 */
export interface PersData extends BaseData {
    linkSyst: PersLinkSyst;
    /** Global gövt id, or null for independent. */
    govt: string | null;
    /** 1 wimpy trader, 2 brave trader, 3 warship, 4 interceptor. */
    aiType: number;
    /** How close ships must be before attacking: 1 (close) - 3 (far). */
    aggression: number;
    /** Percent of shield capacity at which the person flees. */
    cowardice: number;
    /** Global shïp id this person flies. */
    ship: string;
    /** Loadout adjustments over the ship's stock weapons. */
    weapons: PersWeapon[];
    /** Credits carried (boarding booty), +/-25%; 0 none. */
    credits: number;
    /**
     * Percent shield capacity relative to stock (100 = standard,
     * 130 = 30% stronger). Negative makes the person invincible.
     */
    shieldMod: number;
    /** Global PICT id shown in the comms dialog, or null. */
    hailPict: string | null;
    /** Comms-dialog quote (STR# 7100), resolved; "" if none. */
    commQuote: string;
    /** Over-the-radio quote (STR# 7101), resolved; "" if none. */
    hailQuote: string;
    /** Global mïsn id offered when boarded/hailed, or null. */
    linkMission: string | null;
    flags: PersFlags;
    /** Control-bit test expression gating appearance; "" if unused. */
    activeOn: string;
    /** ItemClass of outfits granted when boarded; <= 0 unused. */
    grantClass: number;
    /** Max outfits granted when boarded (actual: grantCount/2..grantCount). */
    grantCount: number;
    /** Percent chance of granting outfits when boarded. */
    grantChance: number;
    /** Subtitle shown under the person's name. */
    subtitle: string;
    /** Ship paint colour as 0x00RRGGBB; 0 means unpainted. */
    color: number;
    startsWithNoFuel: boolean;
}

export function getDefaultPersFlags(): PersFlags {
    return {
        keepsGrudge: false,
        usesEscapePodAndAfterburner: false,
        hailOnlyWithGrudge: false,
        hailOnlyWhenLikesPlayer: false,
        hailOnlyWhenAttacking: false,
        hailOnlyWhenDisabled: false,
        replaceWithSpecialShip: false,
        hailOnlyOnce: false,
        deactivateAfterMission: false,
        offerMissionOnBoarding: false,
        hailOnlyWhenMissionAvailable: false,
        leavesAfterMissionAccepted: false,
        noMissionIfWimpyTrader: false,
        noMissionIfBeefyTrader: false,
        noMissionIfWarship: false,
        showDisasterInfoWhenHailing: false,
    };
}

export function getDefaultPersData(): PersData {
    return {
        ...getDefaultBaseData(),
        linkSyst: { type: 'any' },
        govt: null,
        aiType: 1,
        aggression: 1,
        cowardice: 0,
        ship: "nova:128",
        weapons: [],
        credits: 0,
        shieldMod: 100,
        hailPict: null,
        commQuote: "",
        hailQuote: "",
        linkMission: null,
        flags: getDefaultPersFlags(),
        activeOn: "",
        grantClass: -1,
        grantCount: 0,
        grantChance: 0,
        subtitle: "",
        color: 0,
        startsWithNoFuel: false,
    };
}
