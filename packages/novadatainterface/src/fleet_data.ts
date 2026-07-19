import { BaseData, getDefaultBaseData } from "./base_data.js";


/** One escort ship class in a fleet, with min/max counts. */
export interface FleetEscortChoice {
    /** Global ship id of the escort's ship class. */
    id: string;
    /** Minimum number of this escort to include. */
    min: number;
    /** Maximum number of this escort to include. */
    max: number;
}

/**
 * Where a fleet is allowed to spawn (the flët LinkSyst field, resolved
 * to global ids where possible):
 *  - any: any system (-1).
 *  - system: one specific system (128-2175).
 *  - govtSystems: systems owned by `govt` (10000-10255).
 *  - allySystems: systems owned by an ally of `govt` (15000-15255).
 *  - notGovtSystems: systems owned by anyone but `govt` (20000-20255).
 *  - enemySystems: systems owned by an enemy of `govt` (25000-25255).
 * Ally/enemy resolution goes through govt class numbers (GovtData
 * classes/allies/enemies), evaluated against the spawn system's owning
 * government at spawn time.
 */
export type FleetLinkSyst =
    | { type: 'any' }
    | { type: 'system', id: string }
    | { type: 'govtSystems', govt: string }
    | { type: 'allySystems', govt: string }
    | { type: 'notGovtSystems', govt: string }
    | { type: 'enemySystems', govt: string };

/**
 * A flët: a fleet of ships (a lead ship plus escorts) that appears
 * randomly in systems matching `linkSyst`. All ships in the fleet share
 * the fleet's government.
 *
 * Field semantics follow the EVN Bible's flët section (p. 26). The
 * hyperspace-entry Quote and the random-cargo flag are parsed by the
 * resource parser but not plumbed here yet.
 */
export interface FleetData extends BaseData {
    /** Global ship id of the fleet's lead ship. */
    leadShip: string;

    /** Escort ship classes with min/max counts; unused entries omitted. */
    escorts: FleetEscortChoice[];

    /** Global govt id of the whole fleet, or null for none. */
    govt: string | null;

    /** Which systems the fleet can spawn in. */
    linkSyst: FleetLinkSyst;

    /**
     * NCB test expression; the fleet appears only where it evaluates
     * true (see ncb.ts). Blank means always.
     */
    appearOn: string;
}

export function getDefaultFleetData(): FleetData {
    return {
        ...getDefaultBaseData(),
        leadShip: "default",
        escorts: [],
        govt: null,
        linkSyst: { type: 'any' },
        appearOn: "",
    };
}
