import { CronData } from "novadatainterface/CronData";
import { PlayerState, START_DATE_MS } from "./player_state";
import { ncbTestContext } from "./ncb_runtime";
import {
    evaluateTestExpression,
    executeSetOperations,
    parseSetExpression,
} from "./ncb";
import { hashSample } from "../spaceport/availability";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActiveCronEvent {
    id: string;
    startedDate: number;
    duration: number;
    onEnd: string;
}

export interface CronEvaluationResult {
    executedStarts: string[];
    executedEnds: string[];
    activeCrons: ActiveCronEvent[];
}

export function getCalendarDate(gameDate: number): { day: number; month: number; year: number } {
    const d = new Date(START_DATE_MS + Math.floor(gameDate) * DAY_MS);
    return {
        day: d.getUTCDate(),
        month: d.getUTCMonth() + 1,
        year: d.getUTCFullYear(),
    };
}

export function isCronDateEligible(
    cron: CronData,
    date: { day: number; month: number; year: number },
): boolean {
    if (cron.firstYear > 0) {
        if (date.year < cron.firstYear) return false;
        if (date.year === cron.firstYear && cron.firstMonth > 0) {
            if (date.month < cron.firstMonth) return false;
            if (date.month === cron.firstMonth && cron.firstDay > 0) {
                if (date.day < cron.firstDay) return false;
            }
        }
    }
    if (cron.lastYear > 0) {
        if (date.year > cron.lastYear) return false;
        if (date.year === cron.lastYear && cron.lastMonth > 0) {
            if (date.month > cron.lastMonth) return false;
            if (date.month === cron.lastMonth && cron.lastDay > 0) {
                if (date.day > cron.lastDay) return false;
            }
        }
    }
    return true;
}

/**
 * Evaluates active and eligible crön scheduled events against the player's
 * current game date and NCB control bits.
 */
export function evaluateCrons(
    crons: readonly CronData[],
    state: PlayerState,
    activeCrons: ActiveCronEvent[] = [],
): CronEvaluationResult {
    const executedStarts: string[] = [];
    const executedEnds: string[] = [];
    let currentActive = [...activeCrons];

    // 1. Process expirations for active cron events
    const remainingActive: ActiveCronEvent[] = [];
    for (const event of currentActive) {
        if (state.gameDate >= event.startedDate + event.duration) {
            if (event.onEnd?.trim()) {
                try {
                    const ops = parseSetExpression(event.onEnd);
                    executeSetOperations(ops, state.missionBits);
                    executedEnds.push(event.id);
                } catch (e) {
                    console.warn(`Failed to execute onEnd for cron ${event.id}:`, e);
                }
            }
        } else {
            remainingActive.push(event);
        }
    }
    currentActive = remainingActive;

    // 2. Evaluate eligible pending crons (with loop guard for continuous iterative crons)
    const calDate = getCalendarDate(state.gameDate);
    const alreadyStarted = new Set(currentActive.map(e => e.id));

    let maxPasses = 5;
    while (maxPasses-- > 0) {
        let changed = false;
        for (const cron of crons) {
            if (alreadyStarted.has(cron.id)) {
                continue;
            }
            if (!isCronDateEligible(cron, calDate)) {
                continue;
            }
            if (cron.enableOn?.trim()) {
                const ctx = ncbTestContext(state);
                try {
                    if (!evaluateTestExpression(cron.enableOn, ctx)) {
                        continue;
                    }
                } catch (e) {
                    continue;
                }
            }
            if (cron.random > 0 && cron.random < 100) {
                const sample = hashSample(`${cron.id}:${Math.floor(state.gameDate)}`);
                if (sample >= cron.random) {
                    continue;
                }
            }

            // Execute onStart
            if (cron.onStart?.trim()) {
                try {
                    const ops = parseSetExpression(cron.onStart);
                    executeSetOperations(ops, state.missionBits);
                    executedStarts.push(cron.id);
                    changed = true;
                } catch (e) {
                    console.warn(`Failed to execute onStart for cron ${cron.id}:`, e);
                }
            }

            if (cron.duration > 0) {
                alreadyStarted.add(cron.id);
                currentActive.push({
                    id: cron.id,
                    startedDate: state.gameDate,
                    duration: cron.duration,
                    onEnd: cron.onEnd,
                });
            } else if (cron.onEnd?.trim()) {
                try {
                    const ops = parseSetExpression(cron.onEnd);
                    executeSetOperations(ops, state.missionBits);
                    executedEnds.push(cron.id);
                    changed = true;
                } catch (e) {
                    console.warn(`Failed to execute immediate onEnd for cron ${cron.id}:`, e);
                }
            }
        }
        if (!changed) {
            break;
        }
    }

    return {
        executedStarts,
        executedEnds,
        activeCrons: currentActive,
    };
}
