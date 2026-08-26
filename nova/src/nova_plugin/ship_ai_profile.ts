import { ShipData } from 'novadatainterface/ShipData';

export type ShipAIRole =
    | 'wimpy-trader'
    | 'brave-trader'
    | 'warship'
    | 'interceptor';

export interface ShipAIProfile {
    readonly role: ShipAIRole;
    /**
     * Desired standoff as a multiplier of maximum weapon range. Smaller
     * values make the ship close more eagerly.
     */
    readonly weaponStandoffMultiplier: number;
    /** Whether the ship may choose an unprovoked hostile target. */
    readonly initiatesCombat: boolean;
    /**
     * Maximum pursuit distance as a multiplier of weapon range once a target
     * is fleeing.
     */
    readonly pursuitRangeMultiplier: number;
    /** Immediately runs from a ship that attacks it. */
    readonly fleesWhenAttacked: boolean;
    /** Breaks off once its attacker is beyond this ship's weapon range. */
    readonly breaksOffOutOfRange: boolean;
    /** Leaves the system after exhausting its target list. */
    readonly jumpsWithoutEnemies: boolean;
    /** Holds station near a planet after exhausting its target list. */
    readonly parksWithoutEnemies: boolean;
    /** Defends any observed non-enemy ship from fire or boarding. */
    readonly policesPiracy: boolean;
}

function profile(
    role: ShipAIRole,
    weaponStandoffMultiplier: number,
    initiatesCombat: boolean,
    pursuitRangeMultiplier: number,
    behavior: Pick<
        ShipAIProfile,
        'fleesWhenAttacked'
        | 'breaksOffOutOfRange'
        | 'jumpsWithoutEnemies'
        | 'parksWithoutEnemies'
        | 'policesPiracy'
    >,
): ShipAIProfile {
    return Object.freeze({
        role,
        weaponStandoffMultiplier,
        initiatesCombat,
        pursuitRangeMultiplier,
        ...behavior,
    });
}

// Bible, shïp/InherentAI: "Visits planets and runs away when attacked".
const WIMPY_TRADER = profile('wimpy-trader', 1, false, 1, {
    fleesWhenAttacked: true,
    breaksOffOutOfRange: false,
    jumpsWithoutEnemies: false,
    parksWithoutEnemies: false,
    policesPiracy: false,
});
// Bible, shïp/InherentAI: "Visits planets and fights back when attacked, but
// runs away when his attacker is out of range."
const BRAVE_TRADER = profile('brave-trader', 0.9, false, 1.5, {
    fleesWhenAttacked: false,
    breaksOffOutOfRange: true,
    jumpsWithoutEnemies: false,
    parksWithoutEnemies: false,
    policesPiracy: false,
});
// Bible, shïp/InherentAI: "Seeks out and attacks his enemies, or jumps out if
// there aren't any."
const WARSHIP = profile('warship', 0.75, true, 3, {
    fleesWhenAttacked: false,
    breaksOffOutOfRange: false,
    jumpsWithoutEnemies: true,
    parksWithoutEnemies: false,
    policesPiracy: false,
});
// Bible, shïp/InherentAI: "Seeks out his enemies, or parks in orbit around a
// planet if he can't find any" and attacks a ship that fires on or attempts to
// board another non-enemy ship while watching.
const INTERCEPTOR = profile('interceptor', 0.55, true, 5, {
    fleesWhenAttacked: false,
    breaksOffOutOfRange: false,
    jumpsWithoutEnemies: false,
    parksWithoutEnemies: true,
    policesPiracy: true,
});

// The 288 retail shïp resources use 1 through 4, not the zero-based values
// implied by their order in the Bible: Shuttles are 1, Federation warships
// are 3, and the dedicated Viper variants are 4.
const RETAIL_PROFILES = new Map<number, ShipAIProfile>([
    [1, WIMPY_TRADER],
    [2, BRAVE_TRADER],
    [3, WARSHIP],
    [4, INTERCEPTOR],
]);

/**
 * Resolve the retail behaviour encoded by a ship hull.
 *
 * The Bible defines only these four types, but plug-ins and malformed data may
 * carry anything. Falling back to the non-initiating profile is safer than
 * making an unknown civilian attack or chase indefinitely.
 */
export function getShipAIProfile(
    shipData: Pick<ShipData, 'inherentAI'>,
): ShipAIProfile {
    return RETAIL_PROFILES.get(shipData.inherentAI) ?? WIMPY_TRADER;
}
