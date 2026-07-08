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
    max: number
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
        max: 0
    }
}
