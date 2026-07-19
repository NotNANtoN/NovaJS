import { CronData } from 'novadatainterface/cron_data';
import { dateFromDayNumber } from './calendar.js';
import { makeControlBitHooks, NCBParseError, runNCBSet, evaluateNCBTest } from './ncb.js';
import { CronState, CronStates } from './player_state_plugin.js';

/**
 * Per-player crön evaluation, run for each day the player's calendar
 * advances (jumps and landings). Follows the crön lifecycle from the
 * EVN Bible: while idle and inside the date range with EnableOn
 * passing, the daily Random% roll activates the event; PreHoldoff
 * days later OnStart runs; Duration days after that OnEnd runs; then
 * PostHoldoff days must pass before it may activate again.
 *
 * Simplifications (documented gaps): Contribute/Require flags are
 * ignored, the news strings are not shown, and the loop-OnStart /
 * loop-OnEnd flags run their string once. Cron set strings run with
 * bit hooks only, so exotic operators (Gxxx, Sxxx, ...) are ignored
 * with a console warning.
 */

function inDateRange(cron: CronData, day: number): boolean {
    const date = dateFromDayNumber(day);
    const first = { day: cron.firstDay, month: cron.firstMonth, year: cron.firstYear };
    const last = { day: cron.lastDay, month: cron.lastMonth, year: cron.lastYear };
    // 0/-1 fields are wildcards. Compare as full dates with the
    // wildcarded components substituted from the current date.
    const fromParts = {
        day: first.day > 0 ? first.day : 1,
        month: first.month > 0 ? first.month : 1,
        year: first.year > 0 ? first.year : -Infinity,
    };
    const toParts = {
        day: last.day > 0 ? last.day : 31,
        month: last.month > 0 ? last.month : 12,
        year: last.year > 0 ? last.year : Infinity,
    };
    const value = (d: { day: number, month: number, year: number }) =>
        (d.year * 12 + (d.month - 1)) * 31 + (d.day - 1);
    return value(date) >= value(fromParts) && value(date) <= value(toParts);
}

function runCronSetString(expression: string, bits: Set<number>,
    random: () => number): void {
    if (!expression) {
        return;
    }
    try {
        runNCBSet(expression, makeControlBitHooks(bits), random);
    } catch (e) {
        if (e instanceof NCBParseError) {
            console.warn('Bad crön set string:', e.message);
            return;
        }
        throw e;
    }
}

function enableOnPasses(cron: CronData, bits: Set<number>): boolean {
    try {
        return evaluateNCBTest(cron.enableOn, {
            getBit: bit => bits.has(bit),
        });
    } catch (e) {
        if (e instanceof NCBParseError) {
            console.warn('Bad crön EnableOn:', e.message);
            return false;
        }
        throw e;
    }
}

/**
 * Steps one cron's state machine for day `day`, running its set
 * strings against `bits` as it starts/ends.
 */
function stepCron(cron: CronData, state: CronState, day: number,
    bits: Set<number>, random: () => number): void {
    if (state.phase === 'idle') {
        if (day < state.nextEligible) {
            return;
        }
        if (!inDateRange(cron, day)) {
            return;
        }
        if (!enableOnPasses(cron, bits)) {
            return;
        }
        const chance = cron.random >= 100 ? 100 : Math.max(0, cron.random);
        if (random() * 100 >= chance) {
            return;
        }
        state.phase = 'pre';
        state.phaseStart = day;
        // Fall through so preHoldoff 0 starts today.
    }
    if (state.phase === 'pre') {
        if (day < state.phaseStart + Math.max(0, cron.preHoldoff)) {
            return;
        }
        runCronSetString(cron.onStart, bits, random);
        state.phase = 'active';
        state.phaseStart = day;
        // Fall through so duration 0 ends today.
    }
    if (state.phase === 'active') {
        if (day < state.phaseStart + Math.max(0, cron.duration)) {
            return;
        }
        runCronSetString(cron.onEnd, bits, random);
        state.phase = 'idle';
        state.phaseStart = day;
        state.nextEligible = day + Math.max(0, cron.postHoldoff) + 1;
    }
}

/**
 * Advances the cron state machines from `fromDay` (exclusive) to
 * `toDay` (inclusive), mutating `states` and `bits`.
 */
export function runCronsForDays(crons: CronData[], states: CronStates,
    bits: Set<number>, fromDay: number, toDay: number,
    random: () => number = Math.random): void {
    for (let day = fromDay + 1; day <= toDay; day++) {
        for (const cron of crons) {
            let state = states.get(cron.id);
            if (!state) {
                state = { phase: 'idle', phaseStart: 0, nextEligible: 0 };
                states.set(cron.id, state);
            }
            stepCron(cron, state, day, bits, random);
        }
    }
}
