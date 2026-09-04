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
    /** Jump fuel capacity in units; retail spends 100 units per jump. */
    fuelCapacity: number;
    /**
     * Retail shïp AI type. Nova's data stores the Bible's ordered roles as
     * 1=wimpy trader, 2=brave trader, 3=warship, and 4=interceptor.
     */
    inherentAI: number;
    /**
     * Government this hull belongs to. AvailShipType 2128-2383 and
     * 3128-3383 compare against this field, not the system's government.
     */
    inherentGovt: number;
    /**
     * Combat weight from shïp/Strength. The Bible uses this value, scaled by
     * present shields, when governments decide whether combat odds are
     * favourable.
     */
    strength: number;
    /** The shïp resource's miscellaneous Flags field. */
    flags: number;
    /**
     * Percent chance this hull is offered for hire in a bar on a given day
     * (EV Nova Bible, shïp/HireRandom). Zero means never.
     */
    hireRandom: number;
    /**
     * Which of the four escort categories the escort menu files this hull
     * under: 0 fighter, 1 medium ship, 2 warship, -1 decide at runtime.
     */
    escortType: number;
    cost: number;
    pict: string;
    /** Marketing art from the ship dësc's Graphic field; absent when unset. */
    infoPict: string | null;
    /** Fixed retail targeting art; absent when no suitable PICT can be found. */
    targetPict?: string;
    longName: string;
    length: number;
    crew: number;
    /** Raw outfit space before stock outfits are subtracted. */
    freeSpace: number;
    maxGuns: number;
    maxTurrets: number;
    /** The smaller second line shown beneath the ship name when targeted. */
    subtitle: string;
    desc: string;
    outfits: { [index: string]: number }
    initialExplosion: string | null;
    finalExplosion: string | null;
    largeExplosion: boolean;
    deathDelay: number;
    displayWeight: number;
    techLevel: number;
    /**
     * Percent chance this hull is offered for sale in a shipyard on a given day
     * (EV Nova Bible, shïp/BuyRandom). Zero means never.
     */
    buyRandom: number;
    flags3?: number;
    shortName?: string;
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
        fuelCapacity: 0,
        inherentAI: 1,
        inherentGovt: -1,
        strength: 1,
        flags: 0,
        hireRandom: 0,
        escortType: -1,
        cost: 0,
        pict: "default",
        infoPict: null,
        targetPict: undefined,
        longName: "",
        length: 0,
        crew: 0,
        freeSpace: 0,
        maxGuns: 0,
        maxTurrets: 0,
        subtitle: "",
        desc: "default",
        outfits: {},
        initialExplosion: null,
        finalExplosion: null,
        largeExplosion: false,
        deathDelay: 1,
        displayWeight: 1,
        techLevel: 0,
        buyRandom: 0,
        flags3: 0,
        shortName: "",
        availabilityNCB: "",
        appearOn: "",
        onPurchase: "",
        onCapture: "",
        onRetire: ""
    }
}
