import { ShipData } from 'novadatainterface/ShipData';

export interface ShipAIProfile {
    /**
     * Desired standoff as a multiplier of maximum weapon range. Smaller
     * values make the ship close more eagerly.
     */
    readonly weaponStandoffMultiplier: number;
    /**
     * Fraction of maximum armor the ship will lose before trying to
     * disengage.
     */
    readonly disengageDamageFraction: number;
    /** Whether the ship may choose an unprovoked hostile target. */
    readonly initiatesCombat: boolean;
    /**
     * Maximum pursuit distance as a multiplier of weapon range once a target
     * is fleeing.
     */
    readonly pursuitRangeMultiplier: number;
}

function profile(
    weaponStandoffMultiplier: number,
    disengageDamageFraction: number,
    initiatesCombat: boolean,
    pursuitRangeMultiplier: number,
): ShipAIProfile {
    return Object.freeze({
        weaponStandoffMultiplier,
        disengageDamageFraction,
        initiatesCombat,
        pursuitRangeMultiplier,
    });
}

// The Bible orders these roles but does not specify numerical thresholds.
// These modest monotonic steps make the distinctions useful without treating
// the chosen values as a reconstruction of undocumented retail arithmetic.
const WIMPY_TRADER = profile(1, 0.25, false, 1);
const BRAVE_TRADER = profile(0.9, 0.6, false, 1.5);
const WARSHIP = profile(0.75, 0.8, true, 3);
const INTERCEPTOR = profile(0.55, 0.9, true, 5);

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
 * The Bible reserves higher values for escorts/other roles, and plug-ins may
 * add more. Falling back to the non-initiating profile is safer than making
 * an unknown civilian attack or chase indefinitely.
 */
export function getShipAIProfile(
    shipData: Pick<ShipData, 'inherentAI'>,
): ShipAIProfile {
    return RETAIL_PROFILES.get(shipData.inherentAI) ?? WIMPY_TRADER;
}
