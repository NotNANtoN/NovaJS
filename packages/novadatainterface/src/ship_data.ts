import { getDefaultSpaceObjectData, getDefaultSpaceObjectPhysics, SpaceObjectData, SpaceObjectPhysics } from "./space_object_data.js";


export interface ShipPhysics extends SpaceObjectPhysics {
    freeMass: number;
    freeCargo: number;
    maxGuns: number;
    maxTurrets: number;
    // Hyperspace jump behavior (EVN Bible, shïp Flags/Flags2 and oütf
    // ModTypes 23/37):
    // Multiplier on the "normal" hyperspace jump speed (shïp Flags
    // 0x0001 = 75%, 0x0002 = 125%, 0x0004 = 150%).
    jumpSpeedMult: number;
    // shïp Flags2 0x0020, or the "fast jumping" outfit (ModType 37).
    canJumpWithoutSlowing: boolean;
    // Change to the no-jump zone's radius in pixels ("hyperspace dist
    // mod" outfits, ModType 23; the standard radius is 1000).
    jumpDistanceMod: number;
    // Fuel burned per second while the afterburner is engaged.
    // 0 means the ship has no afterburner.
    afterburner: number;
    // Number of EXTRA consecutive hyperspace jumps performed from a single
    // jump initiation ("multi-jump" outfits, ModType 32; summed across
    // outfits). 0 means a normal single jump.
    multiJump: number;
    // Whether the ship slowly regenerates hyperspace fuel on its own
    // ("auto-refueller" outfits, ModType 19). Granted if any outfit has it.
    autoRefuel: boolean;
}

export function getDefaultShipPhysics(): ShipPhysics {
    return {
        ...getDefaultSpaceObjectPhysics(),
        freeMass: 0,
        freeCargo: 0,
        maxGuns: 0,
        maxTurrets: 0,
        jumpSpeedMult: 1,
        canJumpWithoutSlowing: false,
        jumpDistanceMod: 0,
        afterburner: 0,
        multiJump: 0,
        autoRefuel: false,
    }
}

export interface ShipData extends SpaceObjectData {
    physics: ShipPhysics;
    pict: string;
    desc: string;
    outfits: { [index: string]: number }
    initialExplosion: string | null;
    finalExplosion: string | null;
    largeExplosion: boolean;
    deathDelay: number;
    displayWeight: number;
    /**
     * 64-bit flag set contributed while flying this ship, as a hex
     * string (JSON-safe; decode with BigInt). Combined with outfit
     * Contribute sets and checked against Require sets.
     */
    contribute: string;
    /** 64-bit flag set required to buy this ship. Hex string. */
    require: string;
    /**
     * The ship's combat strength rating (shïp Strength), used for the
     * govt MaxOdds fight-or-flee calculation. The Bible scales a ship's
     * effective strength between 30% and 100% of this by its current
     * shield level.
     */
    strength: number;
    /**
     * The ship class's inherent AI type (shïp InherentAI, 1 = wimpy
     * trader, 2 = brave trader, 3 = warship, 4 = interceptor), used
     * when a düde with AIType 0 spawns this ship.
     */
    inherentAI: number;
};

export function getDefaultShipData(): ShipData {
    return {
        ...getDefaultSpaceObjectData(),
        physics: getDefaultShipPhysics(),
        pict: "default",
        desc: "default",
        outfits: {},
        initialExplosion: null,
        finalExplosion: null,
        largeExplosion: false,
        deathDelay: 1,
        displayWeight: 1,
        contribute: "0x0",
        require: "0x0",
        strength: 0,
        inherentAI: 1,
    }
}
