import { BaseData, getDefaultBaseData } from "./base_data.js";
import { CloakData, getDefaultCloakData } from "./cloak_data.js";
import { ShipPhysics } from "./ship_data.js";


export type OutfitPhysics = Partial<ShipPhysics> & { freeMass: number };

export interface OutfitData extends BaseData {
    weapons: { [index: string]: number }, // globalID : count

    // how it changes the physics of the ship it's attached to. Idea: What if these were allowed to be functions?
    physics: OutfitPhysics,
    // Cloaking-device semantics decoded from ModType 17. isCloak is false
    // for non-cloak outfits. See cloak_data.ts for the bitfield.
    cloak: CloakData,
    // The weapon (globalID) this outfit is ammunition for, or null.
    // Each item of the outfit is one round of that weapon's ammo.
    ammoFor: string | null,
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
        cloak: getDefaultCloakData(),
        ammoFor: null,
        pict: "default",
        price: 0,
        desc: "default outfit",
        displayWeight: 0,
        max: 0
    }
}
