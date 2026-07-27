import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/vector';

/**
 * ============================================================================
 * Boarding and plundering disabled ships (EVN Bible)
 * ============================================================================
 *
 * When a ship is DISABLED (disabled_component.ts) the player can pull
 * alongside and BOARD it. The Bible's boarding model:
 *
 *  - dude Booty flags (gövt/düde section) decide what a boarded ship
 *    yields: food/industrial/medical/luxury/metal/equipment cargo,
 *    money ("amount depends on the ship's purchase price"), or nothing
 *    at all ("repelled while attempting to board").
 *  - "Ships with 0 crew can't be boarded, nor can they capture any
 *    other ships" (shïp Crew).
 *  - capture odds relate to crew, and the marines outfit (oütf ModType
 *    25) "Adds the value in ModVal to your ship's effective crew
 *    complement when calculating capture odds".
 *  - BoardPenalty (gövt) is "Evilness from pirating one of this govt's
 *    ships".
 *
 * NovaJS SIMPLIFICATIONS (documented, since the Bible leaves the exact
 * numbers to the engine):
 *  - Booty flags are not modeled per-dude yet. A boarded ship instead
 *    yields the cargo it is actually carrying (its CargoComponent, up to
 *    the boarder's free hold), a money booty derived from its purchase
 *    price (CREDIT_BOOTY_FRACTION), and its remaining fuel. This reuses
 *    the live cargo/fuel/price data every ship already has; wiring the
 *    dude Booty-flag table (and the "repelled, nothing to take" case) is
 *    a documented follow-up.
 *  - Capture odds use a crew-ratio formula (captureChance) with no
 *    marines term, because ModType 25 is not parsed yet. The marines
 *    additive is a documented seam in captureChance's caller.
 *
 * MATTHEW'S EXPLICIT SPEC (authoritative): boarding additionally
 * requires the boarding ship's axis to be ALIGNED with the target's —
 * facing the same way or exactly opposite (parallel or anti-parallel),
 * within AXIS_ALIGN_TOLERANCE_RAD. See axesAligned.
 *
 * DETERMINISM / ROLLBACK: BoardingComponent (on the boarder) and
 * BoardedComponent (on the victim) are real, serializer-registered sim
 * state, so every peer's world agrees on who is boarding whom and what
 * has already been taken. All transfers are computed by a sim system
 * from replayed control inputs (boarding_plugin.ts); the capture roll
 * draws from the seeded RandomResource inside that system, never from
 * client randomness. This module holds only the component types, the
 * tuning constants, and the pure helpers — no system imports — so any
 * gameplay system can import the components without a cycle.
 */

/**
 * Present on the boarding ship while a plunder session is open against
 * `target`. Cleared when the player finishes (the 'done' action) or
 * when the target leaves the world / stops being boardable.
 */
export const BoardingState = t.type({
    /** UUID of the disabled ship being boarded. */
    target: t.string,
    /** Money booty offered, frozen at board time from the victim's
     * purchase price (the victim is a live entity that could be
     * destroyed mid-session, so the amount must not be re-derived). */
    creditsAvailable: t.number,
    cargoTaken: t.boolean,
    creditsTaken: t.boolean,
    fuelTaken: t.boolean,
    /**
     * Capture-attempt state, driving the capture-assignment dialog:
     *  'none'      no attempt yet (or the last attempt was repelled and
     *              the player may try again),
     *  'failed'    the most recent attempt was repelled,
     *  'succeeded' the ship was captured; the assignment dialog is up,
     *  'assigned'  the captured ship has been taken as an escort.
     */
    capture: t.union([
        t.literal('none'), t.literal('failed'),
        t.literal('succeeded'), t.literal('assigned')]),
    /** Whether the BoardPenalty crime has been charged this session. */
    crimeApplied: t.boolean,
});
export type BoardingState = t.TypeOf<typeof BoardingState>;
export const BoardingComponent = new Component<BoardingState>('Boarding');

/** Present on a ship while/after it is boarded, naming the boarder.
 * Blocks a second boarding and marks the ship for mission-goal
 * tracking (mission_ship_state.ts shipBoarded seam). */
export const BoardedState = t.type({ boarder: t.string });
export type BoardedState = t.TypeOf<typeof BoardedState>;
export const BoardedComponent = new Component<BoardedState>('Boarded');

/**
 * Boarding window (mirrors the landing gate in planet_plugin.ts).
 * TUNABLE: 150 px center-to-center is "pulled alongside" for the small
 * ship sprites, and the same slow-speed threshold as landing, applied
 * to the RELATIVE velocity so you must match the drifting hulk's motion
 * rather than merely be slow in absolute terms.
 */
export const BOARD_DISTANCE_SQUARED = 22_500;
export const BOARD_REL_SPEED_SQUARED = 3_000;

/**
 * Axis-alignment tolerance (Matthew's spec). TUNABLE: 15 degrees each
 * side of parallel and of anti-parallel — tight enough that you must
 * deliberately line up with the hulk, loose enough to be achievable by
 * hand.
 */
export const AXIS_ALIGN_TOLERANCE_RAD = Math.PI / 12;

/**
 * Money booty as a fraction of the victim's purchase price (Bible:
 * "amount depends on the ship's purchase price"; the fraction is
 * undocumented). TUNABLE.
 */
export const CREDIT_BOOTY_FRACTION = 0.10;

/** Capture-chance clamp, so a wildly one-sided crew count still leaves
 * a sliver of uncertainty either way. */
export const CAPTURE_CHANCE_MIN = 0.05;
export const CAPTURE_CHANCE_MAX = 0.95;

/**
 * Whether two ship axes are parallel or anti-parallel within `tol`.
 * Uses the deterministic Angle subtraction (no atan2/trig): the
 * difference lands in [-pi, pi), so |diff| near 0 is parallel and |diff|
 * near pi is anti-parallel.
 */
export function axesAligned(a: Angle, b: Angle,
    tol = AXIS_ALIGN_TOLERANCE_RAD): boolean {
    const diff = Math.abs(a.subtract(b).angle);
    return diff <= tol || diff >= Math.PI - tol;
}

/** Why a board attempt was rejected, or null when it is allowed. */
export type BoardBlockReason =
    | 'noTarget' | 'notDisabled' | 'noCrew'
    | 'tooFar' | 'tooFast' | 'notAligned';

/**
 * Pure boarding gate. Checks, in the order the on-screen feedback
 * prioritizes: a disabled target must be selected, it must have crew
 * (Bible: 0-crew ships can't be boarded), and the boarder must be close,
 * matched in speed, and axis-aligned (Matthew's spec).
 */
export function boardingBlockedReason(input: {
    hasTarget: boolean;
    targetDisabled: boolean;
    targetCrew: number;
    distanceSquared: number;
    relSpeedSquared: number;
    aligned: boolean;
}): BoardBlockReason | null {
    if (!input.hasTarget) {
        return 'noTarget';
    }
    if (!input.targetDisabled) {
        return 'notDisabled';
    }
    if (input.targetCrew <= 0) {
        return 'noCrew';
    }
    if (input.distanceSquared >= BOARD_DISTANCE_SQUARED) {
        return 'tooFar';
    }
    if (input.relSpeedSquared >= BOARD_REL_SPEED_SQUARED) {
        return 'tooFast';
    }
    if (!input.aligned) {
        return 'notAligned';
    }
    return null;
}

/** Money booty from a victim's purchase price (floored, non-negative). */
export function creditBooty(price: number): number {
    return Math.max(0, Math.floor(price * CREDIT_BOOTY_FRACTION));
}

/**
 * Capture probability from crew counts (Bible: odds relate to crew, and
 * marines add to the boarder's effective crew — that additive is a
 * documented seam: ModType 25 is unparsed, so `attackerCrew` is the raw
 * shïp Crew today). A simple share-of-total model, clamped so neither
 * side is ever a certainty.
 */
export function captureChance(attackerCrew: number,
    defenderCrew: number): number {
    if (attackerCrew <= 0) {
        return 0;
    }
    const raw = attackerCrew / (attackerCrew + Math.max(0, defenderCrew));
    return Math.max(CAPTURE_CHANCE_MIN, Math.min(CAPTURE_CHANCE_MAX, raw));
}

/**
 * Plans a cargo plunder: which commodities move and how many tons,
 * greedily filling the boarder's free hold. Keys are visited in sorted
 * order so every peer moves exactly the same tons of the same
 * commodities. Returns [key, tons] entries with tons > 0.
 */
export function planCargoPlunder(
    targetCargo: ReadonlyMap<string, number>,
    freeSpace: number): [string, number][] {
    let remaining = Math.max(0, Math.floor(freeSpace));
    const plan: [string, number][] = [];
    for (const key of [...targetCargo.keys()].sort()) {
        if (remaining <= 0) {
            break;
        }
        const available = targetCargo.get(key) ?? 0;
        const take = Math.min(available, remaining);
        if (take > 0) {
            plan.push([key, take]);
            remaining -= take;
        }
    }
    return plan;
}

/** Fuel that can move from the victim's tank into the boarder's,
 * clamped by both the victim's remaining fuel and the boarder's
 * headroom. */
export function fuelTransferAmount(victimFuel: number, boarderFuel: number,
    boarderFuelMax: number): number {
    return Math.max(0, Math.min(victimFuel, boarderFuelMax - boarderFuel));
}
