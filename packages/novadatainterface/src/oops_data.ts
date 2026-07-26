import { BaseData, getDefaultBaseData } from "./base_data.js";

/**
 * An öops: a "planetary disaster" that temporarily changes the price of
 * a single standard commodity at a stellar object, for good or bad (EVN
 * Bible p. 42, the öops resource). Despite the name these are just price
 * fluctuations — a food surplus, an industrial shortage, and so on.
 *
 * Each day the event has `freq` percent chance of starting; once started
 * it lasts `duration` days and shifts the affected commodity's price by
 * `priceDelta` credits. While active, the resource's `name` (a full
 * sentence, e.g. "An enormous food surplus has lowered the price of
 * food.") is shown in the commodity-exchange dialog.
 */
export interface OopsData extends BaseData {
    /**
     * Global spöb id of the affected stellar, or null when the event is
     * not tied to a specific stellar. When `appliesToAll` is true the
     * event affects every planet/station regardless of this field.
     */
    stellar: string | null;
    /** True for the "any planet or station" wildcard (Stellar = -1). */
    appliesToAll: boolean;
    /**
     * Which standard commodity's price is affected: 0 food, 1 industrial,
     * 2 medical, 3 luxury, 4 metal, 5 equipment. Jünk commodities are
     * never affected.
     */
    commodity: number;
    /** Credits to add to the price; negative lowers it. */
    priceDelta: number;
    /** How many days the event lasts once it starts. */
    duration: number;
    /** Percent chance per day (0-100) that the event starts. */
    freq: number;
    /** NCB test gating whether the event can activate (empty = always). */
    activateOn: string;
}

export function getDefaultOopsData(): OopsData {
    return {
        ...getDefaultBaseData(),
        stellar: null,
        appliesToAll: false,
        commodity: 0,
        priceDelta: 0,
        duration: 0,
        freq: 0,
        activateOn: "",
    };
}
