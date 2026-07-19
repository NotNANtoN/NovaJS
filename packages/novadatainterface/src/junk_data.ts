import { BaseData, getDefaultBaseData } from "./base_data.js";

/**
 * A jünk: a specialized tradeable commodity bought and sold at a few
 * specific stellar objects (EVN Bible p. 31). Cargo of this type uses
 * the "junk:<globalID>" key scheme in CargoComponent (see
 * cargo_plugin.ts and the röid parser).
 *
 * Price semantics follow the standard commodity tiers: at a stellar
 * where the jünk is *sold* (SoldAt) the player buys it at the low
 * tier (80% of BasePrice); at a stellar where it is *bought*
 * (BoughtAt) the player sells it at the high tier (125%).
 */
export interface JunkData extends BaseData {
    /** Global spöb ids where the player can buy this commodity. */
    soldAt: string[];
    /** Global spöb ids where the player can sell this commodity. */
    boughtAt: string[];
    /** Average price of the commodity. */
    basePrice: number;
    /** Tribbles flag: multiplies in the cargo hold. */
    multiplies: boolean;
    /** Perishable: gradually decays in the cargo hold. */
    decays: boolean;
    /** Lower-case display name, e.g. "machine parts". */
    lcName: string;
    /** Status bar abbreviation, e.g. "Parts". */
    abbrev: string;
    /** NCB test expression; buyable only when true (empty = always). */
    buyOn: string;
    /** NCB test expression; sellable only when true (empty = always). */
    sellOn: string;
}

export function getDefaultJunkData(): JunkData {
    return {
        ...getDefaultBaseData(),
        soldAt: [],
        boughtAt: [],
        basePrice: 0,
        multiplies: false,
        decays: false,
        lcName: "",
        abbrev: "",
        buyOn: "",
        sellOn: "",
    };
}
