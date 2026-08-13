import { SpaceObjectData, getDefaultSpaceObjectData } from "./space_object_data.js";
import { DamageType } from "./weapon_data.js";

/**
 * A hypergate/wormhole transit endpoint, if this stellar is one.
 *
 * Populated from the spöb flags2 hypergate (0x1000) / wormhole (0x2000) bits
 * and the HyperLink1-8 fields (EVN Bible p. 61). See jump_gate_plugin.ts for
 * how transit resolves a destination from this.
 */
export interface GateData {
    kind: "hypergate" | "wormhole";

    /**
     * Global ids of the spöb resources this gate/wormhole connects to (its
     * defined HyperLink1-8 destinations, resolved to global ids; unset -1/0
     * links dropped). For a hypergate these are the choices the player is
     * offered. For a wormhole these are its exit(s); an empty list means the
     * wormhole has no defined links and connects to a random other link-less
     * wormhole (Bible p. 61 "random wormhole" behavior).
     */
    destinations: string[];

    /**
     * The angle (degrees, 0-359) at which ships emerge from the destination
     * gate/wormhole, from the spöb's CustSndID field (which serves this
     * purpose for hypergates/wormholes — Bible p. 60). null means "a random
     * direction" (any CustSndID outside 0-359); callers pick a seeded-random
     * angle so it stays deterministic.
     */
    emergenceAngle: number | null;
}

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
    /**
     * This stellar's outfit shop "can buy any nonpermanent outfits the
     * player owns, regardless of tech level" (EVN Bible ~:2862).
     *
     * NOTE: this bit lives in the spöb **Flags2** field (0x0400), not the
     * Flags field the rest of this interface decodes — the Bible block that
     * documents it is the Flags2 block (the same one carrying hypergate
     * 0x1000 / wormhole 0x2000). It is surfaced here alongside the other
     * named booleans because it is a service property of the stellar.
     *
     * Without it, an outfitter only buys back what it would itself stock
     * (see outfitter_rules.ts sellableHere): the existence of this flag and
     * of the per-outfit 0x0800 "sell anywhere" flag is what establishes that
     * selling is tech-gated by default. Sirrusa is the canonical stock
     * example of a stellar that sets it.
     */
    buysAnyOutfit: boolean;
}

/**
 * A commodity exchange price tier, from the spöb Flags trade nibbles
 * (EVN Bible p. 59): each standard commodity trades at low (80%),
 * medium (100%), or high (125%) of its base price, or not at all.
 */
export type TradeTier = "low" | "med" | "high";

export interface PlanetData extends SpaceObjectData {
    landingPict: string;
    landingDesc: string;
    position: [number, number];

    /**
     * Transit endpoint metadata if this stellar is a hypergate or wormhole,
     * else null. A normal planet/station has no gate.
     */
    gate: GateData | null;

    /**
     * Fee deducted from the player's credits on landing (spöb Fee field,
     * Bible p. 61). Hook only: credits are not yet modeled, so nothing charges
     * this today. Hypergates in stock EV Nova charge no fee (all observed
     * gate/wormhole Fee = 0); kept so a future credits system can honor it.
     */
    landingFee: number;

    /** Global id of the owning gövt, or null for independent. */
    govt: string | null;
    /** Named spöb flag booleans (landability, services, habitation). */
    flags: PlanetFlags;
    /** Tech level, controlling default outfit/ship availability. */
    techLevel: number;
    /**
     * The stellar's special tech levels (spöb SpecialTech x8, EVN Bible
     * p. 63). Unlike techLevel, these do NOT admit everything at or below
     * them: only items and ships whose own TechLevel EXACTLY equals one of
     * these appear here. That is how a low-tech world stocks a few exotic
     * items, and how an item given an absurd TechLevel (the Bible's example
     * is 15000) can be made to appear at exactly one stellar.
     *
     * Unset slots are dropped at parse time (see planet_parse.ts), so this
     * holds only meaningful values and is usually empty. Order is not
     * significant; membership is all the rules test.
     */
    specialTech: number[];
    /**
     * The commodity exchange price tier for each standard commodity
     * (index 0 food, 1 industrial, 2 medical, 3 luxury, 4 metal,
     * 5 equipment), or null when the stellar won't trade in it. From
     * the upper spöb Flags nibbles (EVN Bible p. 59).
     */
    tradeTiers: (TradeTier | null)[];
    /**
     * The bar description (dësc id 10000 + spöb local id - 128), shown
     * in the spaceport bar dialog. Empty when the stellar has none.
     */
    barDesc: string;
    /**
     * The global PICT id of the bar description's Graphic (the bar
     * dësc's Graphic field), shown as an embedded image in the bar's
     * "Bar + pict" frame (PICT 8504). null when the bar has no picture.
     */
    barPict: string | null;

    /**
     * The spöb AnimDelay: frames between animation frames in 30ths of a
     * second (EVN Bible p. 61). 0 means unset. The display turns this into a
     * frame rate (30 / animationDelay) for continuously-animated stellars
     * such as wormholes.
     */
    animationDelay: number;

    /**
     * Global id of the ambient snd resource played on a loop while the
     * player is on this stellar's main spaceport screen (the spöb CustSndID
     * field, EVN Bible p. 60: "Which ambient sound to play"; -1 = none).
     * null when the stellar has no ambient sound. Note: for hypergates and
     * wormholes CustSndID is repurposed as the emergence angle (see `gate`),
     * so those never carry a spaceport ambient sound.
     */
    spaceportSound: string | null;
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
        buysAnyOutfit: false,
    };
}

export function getDefaultPlanetData(): PlanetData {
    return {
        ...getDefaultSpaceObjectData(),
        vulnerableTo: <Array<DamageType>>["planetBuster"],
        landingPict: "default",
        landingDesc: "default",
        position: [0, 0],
        gate: null,
        landingFee: 0,
        govt: null,
        flags: getDefaultPlanetFlags(),
        techLevel: 0,
        specialTech: [],
        tradeTiers: [null, null, null, null, null, null],
        barDesc: "",
        barPict: null,
        animationDelay: 0,
        spaceportSound: null,
    };
}
