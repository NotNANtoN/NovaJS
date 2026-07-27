import * as t from 'io-ts';
import { map } from 'nova_ecs/datatypes/map';

/**
 * ============================================================================
 * Mission special-ship objectives: the per-mission progress state
 * ============================================================================
 *
 * A mission with special ships (mïsn ShipCount/ShipDude/ShipGoal)
 * carries a ShipObjective inside its ActiveMission. Everything the
 * SHARED simulation needs to evaluate the goal is frozen in here at
 * accept time (goal code, resolved spawn system, ship count), so the
 * sim never touches mission game data.
 *
 * This module is pure state + transitions with no ECS imports, so the
 * goal state machine is unit-testable and both the player-local
 * mission logic (mission_logic.ts) and the sim systems
 * (mission_ship_plugin.ts) can import it without cycles.
 *
 * The EVN Bible's goal codes (mïsn ShipGoal):
 *   -1 none      ships are scenery/ambushers; never block completion.
 *    0 destroy   "Destroy all the ships": each death counts; done when
 *                all ShipCount ships have died.
 *    1 disable   "Disable but don't destroy them": each ship counts
 *                the tick it becomes disabled. A ship destroyed before
 *                it was disabled makes the goal unachievable => the
 *                mission fails (at the next landing).
 *    2 board     "Board them" — boarding does not exist in the engine
 *                yet, so board missions are not offered (see
 *                mission_ship_logic.ts).
 *    3 escort    "Escort them (keep them from getting killed)": the
 *                goal never blocks completion; a mission ship dying
 *                fails the mission. Stock escort missions use ShipSyst
 *                -6 (follow the player), so the ships are respawned
 *                alongside the player in each system they enter.
 *    4 observe   "Observe them": a ship that cannot cloak is observed
 *                by merely sharing the system with the player; a
 *                cloak-capable ship must be seen up close while
 *                visible (OBSERVE_RANGE).
 *    5 rescue    "They start out disabled ... until you board them" —
 *                needs boarding; not offered, like board.
 *    6 chase off "Either kill them or scare them into jumping out of
 *                the system": a death OR a departure counts.
 *
 * Ships surviving after the goal completes LINGER: the Bible does not
 * say they leave, and the auto-abort flag's wording implies they stay
 * in play until the mission ends. They are despawned when their
 * owner's mission ends (which, since every mission-ending transition
 * happens while the owner is docked, is subsumed by the owner-absence
 * cleanup in mission_ship_plugin.ts).
 */

export const GOAL_NONE = -1;
export const GOAL_DESTROY = 0;
export const GOAL_DISABLE = 1;
export const GOAL_BOARD = 2;
export const GOAL_ESCORT = 3;
export const GOAL_OBSERVE = 4;
export const GOAL_RESCUE = 5;
export const GOAL_CHASE_OFF = 6;

/** Per-tracked-ship progress flags. */
export const ShipObjectiveLiveType = t.partial({
    /** The ship has been observed (GOAL_OBSERVE). */
    observed: t.boolean,
    /** The ship has been disabled (GOAL_DISABLE). */
    disabled: t.boolean,
    /** The ship has been boarded (GOAL_BOARD seam; see shipBoarded). */
    boarded: t.boolean,
});
export type ShipObjectiveLive = t.TypeOf<typeof ShipObjectiveLiveType>;

/**
 * The special-ship objective of one active mission. Serializable state
 * on the owner's MissionsComponent; mutated by the shared sim's goal
 * systems (identically on every peer) and read at landing.
 */
export const ShipObjectiveType = t.type({
    /** ShipGoal code (see the module comment). */
    goal: t.number,
    /**
     * The system the ships appear in, resolved and frozen at accept
     * time; null means ShipSyst -6, "whatever system the player is in".
     */
    systemId: t.union([t.string, t.null]),
    /** Where in the system the ships start (mïsn ShipStart). */
    shipStart: t.number,
    /** ShipBehav code (-1 standard; 0 attack player; 1 protect). */
    behavior: t.number,
    /** Global düde id the ships are drawn from. */
    dudeId: t.string,
    /** ShipCount. */
    total: t.number,
    /** Ships whose per-ship objective is done (killed/disabled/...). */
    satisfied: t.number,
    /** The goal is complete (never true for GOAL_ESCORT/GOAL_NONE). */
    complete: t.boolean,
    /** The goal can no longer be achieved; fail the mission on landing. */
    failed: t.boolean,
    /** OnShipDone has not run yet (runs at the next date advance — the
     * first jump or landing after the goal completes). */
    shipDonePending: t.boolean,
    /** Live tracked mission ships (uuid -> per-ship flags). Cleared by
     * the owner's client before it re-enters a system. */
    live: map(t.string, ShipObjectiveLiveType),
});
export type ShipObjective = t.TypeOf<typeof ShipObjectiveType>;

/**
 * Goals the engine can evaluate; the rest stay unofferable.
 *
 * SEAM: player boarding now exists (boarding_plugin.ts), and the goal
 * state machine already tracks it (shipBoarded, below, and GOAL_BOARD in
 * countsDown). Board (2) missions remain UNOFFERED here on purpose: the
 * remaining step is to have MissionShipTrackSystem detect the shared
 * BoardedComponent and call shipBoarded, then flip GOAL_BOARD to
 * supported and update mission_ship_state_test / mission_logic_test.
 * Rescue (5) additionally needs the "spawn disabled and stay disabled"
 * mechanic, which is not built.
 */
export function goalSupported(goal: number): boolean {
    return goal === GOAL_NONE || goal === GOAL_DESTROY
        || goal === GOAL_DISABLE || goal === GOAL_ESCORT
        || goal === GOAL_OBSERVE || goal === GOAL_CHASE_OFF;
}

/** Goals whose remaining ships count down as they are satisfied (the
 * owner's client spawns total - satisfied on each system entry). */
function countsDown(goal: number): boolean {
    return goal === GOAL_DESTROY || goal === GOAL_DISABLE
        || goal === GOAL_OBSERVE || goal === GOAL_CHASE_OFF
        || goal === GOAL_BOARD;
}

/** How many ships the owner's client should spawn on system entry. */
export function shipsToSpawn(objective: ShipObjective): number {
    if (objective.failed || objective.complete) {
        return 0;
    }
    if (!countsDown(objective.goal)) {
        return objective.total;
    }
    return Math.max(0, objective.total - objective.satisfied);
}

function updateCompletion(objective: ShipObjective): void {
    if (!objective.complete && countsDown(objective.goal)
        && objective.satisfied >= objective.total) {
        objective.complete = true;
        objective.shipDonePending = true;
    }
}

/** A newly inserted mission ship starts being tracked. */
export function registerShip(objective: ShipObjective, uuid: string): void {
    if (!objective.live.has(uuid)) {
        objective.live.set(uuid, {});
    }
}

/** A tracked ship died (the shared sim's DeathEvent). */
export function shipDied(objective: ShipObjective, uuid: string): void {
    const flags = objective.live.get(uuid);
    if (!flags) {
        return;
    }
    objective.live.delete(uuid);
    switch (objective.goal) {
        case GOAL_DESTROY:
        case GOAL_CHASE_OFF:
            objective.satisfied++;
            break;
        case GOAL_DISABLE:
            // Destroyed before it was disabled: unachievable.
            if (!flags.disabled) {
                objective.failed = true;
            }
            break;
        case GOAL_ESCORT:
            objective.failed = true;
            break;
        // GOAL_OBSERVE: an unobserved ship dying just leaves fewer to
        // observe now; the remainder respawn on the next system entry.
    }
    updateCompletion(objective);
}

/**
 * A tracked ship left the simulation without dying (an NPC jump-out,
 * or a flee that reached the system edge).
 */
export function shipDeparted(objective: ShipObjective, uuid: string): void {
    if (!objective.live.has(uuid)) {
        return;
    }
    objective.live.delete(uuid);
    if (objective.goal === GOAL_CHASE_OFF) {
        // "Scare them into jumping out of the system."
        objective.satisfied++;
    }
    updateCompletion(objective);
}

/** A tracked ship became disabled. */
export function shipDisabled(objective: ShipObjective, uuid: string): void {
    const flags = objective.live.get(uuid);
    if (!flags || flags.disabled) {
        return;
    }
    flags.disabled = true;
    if (objective.goal === GOAL_DISABLE) {
        objective.satisfied++;
        updateCompletion(objective);
    }
}

/**
 * A tracked ship has been boarded by the owner (GOAL_BOARD). Mirrors
 * shipDisabled: one board counts once. This is the mission-side hook for
 * boarding_plugin.ts; it is dormant until GOAL_BOARD is made offerable
 * (see goalSupported), but is unit-tested so the seam stays correct.
 */
export function shipBoarded(objective: ShipObjective, uuid: string): void {
    const flags = objective.live.get(uuid);
    if (!flags || flags.boarded) {
        return;
    }
    flags.boarded = true;
    if (objective.goal === GOAL_BOARD) {
        objective.satisfied++;
        updateCompletion(objective);
    }
}

/** A tracked ship has been observed by the owner. */
export function shipObserved(objective: ShipObjective, uuid: string): void {
    const flags = objective.live.get(uuid);
    if (!flags || flags.observed) {
        return;
    }
    flags.observed = true;
    if (objective.goal === GOAL_OBSERVE) {
        objective.satisfied++;
        updateCompletion(objective);
    }
}

/**
 * Whether the objective permits mission completion at the return
 * stellar: escort ships must merely have stayed alive; counting goals
 * must be complete; goalless ships never block.
 */
export function objectiveAllowsCompletion(objective: ShipObjective): boolean {
    if (objective.failed) {
        return false;
    }
    switch (objective.goal) {
        case GOAL_NONE:
        case GOAL_ESCORT:
            return true;
        default:
            return objective.complete;
    }
}
