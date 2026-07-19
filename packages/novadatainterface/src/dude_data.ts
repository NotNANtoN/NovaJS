import { BaseData, getDefaultBaseData } from "./base_data.js";


/** One ship class a dude can spawn as, with its relative weight. */
export interface DudeShipChoice {
    /** Global ship id, e.g. "nova:128". */
    id: string;
    /**
     * Relative probability weight (the düde's Probability field, in
     * percent). Weights are normalized at selection time, so they need
     * not sum to 100.
     */
    weight: number;
}

/**
 * A düde: a container for ship classes that share an AI type, a
 * government, and boarding booty. NPC spawning picks a concrete ship
 * class from `ships` using the weights, then applies `aiType` and
 * `govt` to the spawned ship.
 *
 * Field semantics follow the EVN Bible's düde section (pp. 24-25).
 * Booty and hail-info fields are parsed by the resource parser but not
 * plumbed here yet; boarding does not exist in the sim.
 */
export interface DudeData extends BaseData {
    /**
     * AI type for ships of this dude class: 1 = wimpy trader, 2 = brave
     * trader, 3 = warship, 4 = interceptor. 0 means each ship uses its
     * own inherent AI type (ShipData.inherentAI).
     */
    aiType: number;

    /** Global govt id, or null for independent. */
    govt: string | null;

    /** Ship classes this dude can spawn, with selection weights. */
    ships: DudeShipChoice[];
}

export function getDefaultDudeData(): DudeData {
    return {
        ...getDefaultBaseData(),
        aiType: 0,
        govt: null,
        ships: [],
    };
}
