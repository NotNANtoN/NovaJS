import { createMissionGoalProgress } from './player_state';
import type { MissionGoalProgress } from './player_state';

export type { MissionGoalProgress } from './player_state';

export type MissionGoalEvent =
    | 'destroyed'
    | 'disabled'
    | 'boarded'
    | 'observed'
    | 'lost'
    | 'chasedOff'
    | 'escortSafe';

/**
 * Apply one special-ship event to a mission goal.
 *
 * The counters are deliberately monotonic. A ship can only contribute once
 * because the ECS layer removes the mission-ship marker after death and keeps
 * a disabled ship in the world.
 */
export function advanceMissionGoal(
    progress: MissionGoalProgress,
    event: MissionGoalEvent,
): MissionGoalProgress {
    if (progress.completed) {
        return { ...progress };
    }

    const next = { ...progress };
    switch (event) {
        case 'destroyed':
            next.destroyed++;
            break;
        case 'disabled':
            next.disabled++;
            break;
        case 'boarded':
            next.boarded++;
            break;
        case 'observed':
            next.observed++;
            break;
        case 'lost':
            next.lost++;
            break;
        case 'chasedOff':
            next.lost++;
            break;
        case 'escortSafe':
            break;
    }

    next.completed = goalIsMet(next, event);
    return next;
}

export function goalIsMet(
    progress: MissionGoalProgress,
    event?: MissionGoalEvent,
): boolean {
    if (progress.total <= 0) {
        return true;
    }

    switch (progress.goal) {
        case 0:
            return progress.destroyed >= progress.total;
        case 1:
            return progress.disabled >= progress.total;
        case 2:
            return progress.boarded >= progress.total;
        case 3:
            // EV Nova Bible, mïsn/ShipGoal 3:
            // "Escort them (keep them from getting killed)."
            return event === 'escortSafe'
                && progress.lost === 0
                && progress.destroyed === 0;
        case 4:
            // EV Nova only needs one visible/non-cloaked special ship to be
            // observed, not every ship in the group.
            return progress.observed > 0;
        case 5:
            // Rescue requires boarding and is intentionally refused by the
            // current UI until boarding exists.
            return progress.boarded >= progress.total;
        case 6:
            // EV Nova Bible, mïsn/ShipGoal 6: "Chase them off (either kill
            // them or scare the into jumping out of the system)."
            return progress.destroyed + progress.lost >= progress.total;
        default:
            return false;
    }
}

export function newMissionGoal(
    goal: number,
    count: number,
): MissionGoalProgress {
    return createMissionGoalProgress(goal, count);
}
