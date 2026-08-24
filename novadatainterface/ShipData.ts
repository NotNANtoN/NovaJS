import { getDefaultSpaceObjectData, getDefaultSpaceObjectPhysics, SpaceObjectData, SpaceObjectPhysics } from "./SpaceObjectData";


export interface ShipPhysics extends SpaceObjectPhysics {
    freeMass: number;
    freeCargo: number;
}

export function getDefaultShipPhysics(): ShipPhysics {
    return {
        ...getDefaultSpaceObjectPhysics(),
        freeMass: 0,
        freeCargo: 0
    }
}

export interface ShipData extends SpaceObjectData {
    physics: ShipPhysics;
    /** Total cargo hold capacity in tons, including cargo expansions. */
    cargoCapacity: number;
    cost: number;
    pict: string;
    desc: string;
    outfits: { [index: string]: number }
    initialExplosion: string | null;
    finalExplosion: string | null;
    largeExplosion: boolean;
    deathDelay: number;
    displayWeight: number;
    availabilityNCB: string;
    appearOn: string;
    onPurchase: string;
    onCapture: string;
    onRetire: string;
};

export function getDefaultShipData(): ShipData {
    return {
        ...getDefaultSpaceObjectData(),
        physics: getDefaultShipPhysics(),
        cargoCapacity: 0,
        cost: 0,
        pict: "default",
        desc: "default",
        outfits: {},
        initialExplosion: null,
        finalExplosion: null,
        largeExplosion: false,
        deathDelay: 1,
        displayWeight: 1,
        availabilityNCB: "",
        appearOn: "",
        onPurchase: "",
        onCapture: "",
        onRetire: ""
    }
}
