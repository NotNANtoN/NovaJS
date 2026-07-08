import { getDefaultSpaceObjectData, getDefaultSpaceObjectPhysics, SpaceObjectData, SpaceObjectPhysics } from "./space_object_data.js";


export interface ShipPhysics extends SpaceObjectPhysics {
    freeMass: number;
    freeCargo: number;
    // Fuel burned per second while the afterburner is engaged.
    // 0 means the ship has no afterburner.
    afterburner: number;
}

export function getDefaultShipPhysics(): ShipPhysics {
    return {
        ...getDefaultSpaceObjectPhysics(),
        freeMass: 0,
        freeCargo: 0,
        afterburner: 0
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
        displayWeight: 1
    }
}
