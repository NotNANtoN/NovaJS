import { BaseData, getDefaultBaseData } from "./base_data.js";
import { ShipPhysics } from "./ship_data.js";


export type OutfitPhysics = Partial<ShipPhysics> & { freeMass: number };

/**
 * The jamming strength this outfit contributes to its ship, for each of the
 * four jamming types (IR, radar, etheric wake, gravimetric). From the oütf
 * ModTypes 33-36 ("Jamming Type 1-4", EVN Bible). Values are percentages that
 * add across all of a ship's outfits (and can be negative). Ordered
 * [type1, type2, type3, type4] to match weapon JamVuln indices.
 */
export type JammingStrengths = readonly [number, number, number, number];

export function getDefaultJammingStrengths(): JammingStrengths {
    return [0, 0, 0, 0];
}

export interface OutfitData extends BaseData {
    weapons: { [index: string]: number }, // globalID : count

    // how it changes the physics of the ship it's attached to. Idea: What if these were allowed to be functions?
    physics: OutfitPhysics,
    /** Per-type jamming strength this outfit adds to the ship. */
    jamming: JammingStrengths,
    pict: string, // id of picture
    price: number,
    desc: string,
    displayWeight: number,
    /** How many you can have (not counting weapon limitations). 0 = unlimited. */
    max: number,
    /** Control bit test expression gating purchase. Blank = available. */
    availability: string,
    /** Control bit set expression evaluated on purchase. */
    onPurchase: string,
    /** Control bit set expression evaluated on sale. */
    onSell: string,
    /**
     * 64-bit flag set contributed while owning this outfit, as a hex
     * string (JSON-safe; decode with BigInt).
     */
    contribute: string,
    /**
     * 64-bit flag set that must be covered by the union of the
     * Contribute sets of the player's ship and outfits to buy this
     * outfit. Hex string; decode with BigInt.
     */
    require: string,
    /** This item occupies a fixed gun hardpoint. */
    fixedGun: boolean,
    /** This item occupies a turret hardpoint. */
    turret: boolean,
    /** This item can't be sold. */
    cantSell: boolean,
    /**
     * The globalID of the weapon whose ammo supply this item fills, or
     * null if this isn't ammunition. Each item of the outfit is one
     * round of that weapon's ammo. Whether the item requires a
     * launcher to buy depends on that weapon's maxAmmo.
     */
    ammoFor: string | null,
    /**
     * The globalID of another outfit whose max count each one of this
     * item multiplies, or null.
     */
    increasesMax: string | null,
}

export function getDefaultOutfitData(): OutfitData {
    return {
        ...getDefaultBaseData(),
        weapons: {},
        physics: {
            freeMass: 0
        },
        jamming: getDefaultJammingStrengths(),
        pict: "default",
        price: 0,
        desc: "default outfit",
        displayWeight: 0,
        max: 0,
        availability: "",
        onPurchase: "",
        onSell: "",
        contribute: "0x0",
        require: "0x0",
        fixedGun: false,
        turret: false,
        cantSell: false,
        ammoFor: null,
        increasesMax: null,
    }
}
