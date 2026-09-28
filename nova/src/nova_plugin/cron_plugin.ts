import { CronData } from "novadatainterface/CronData";
import { CronStateEntry, PlayerState, START_DATE_MS } from "./player_state";
import { ncbTestContext } from "./ncb_runtime";
import {
    evaluateTestExpression,
    executeSetOperations,
    parseSetExpression,
} from "./ncb";
import { createNcbHandlers, NcbHandlerContext } from "./ncb_handlers";
import { Bits64, meetsRequire, orBits, toBits64 } from "./contribute";
import { hashSample } from "../spaceport/availability";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bound for the Flags 0x0001 / 0x0002 "continuous, iterative" loops. */
export const MAX_CRON_ITERATIONS = 64;
/** Bound for a single multi-day catch-up. */
export const MAX_CRON_CATCH_UP_DAYS = 3650;

const CRON_ITERATIVE_START = 0x0001;
const CRON_ITERATIVE_END = 0x0002;

export interface CalendarDate { day: number; month: number; year: number }

export function getCalendarDate(gameDate: number): CalendarDate {
    const d = new Date(START_DATE_MS + Math.floor(gameDate) * DAY_MS);
    return {
        day: d.getUTCDate(),
        month: d.getUTCMonth() + 1,
        year: d.getUTCFullYear(),
    };
}

function set(value: number): boolean {
    return value > 0;
}

/** -1 when a < b, 1 when a > b, over the non-wildcard components of `bound`. */
function compareToBound(
    date: CalendarDate,
    bound: { year: number; month: number; day: number },
): number {
    const parts: Array<[number, number]> = [];
    if (set(bound.year)) parts.push([date.year, bound.year]);
    if (set(bound.month)) parts.push([date.month, bound.month]);
    if (set(bound.day)) parts.push([date.day, bound.day]);
    for (const [a, b] of parts) {
        if (a !== b) return a < b ? -1 : 1;
    }
    return 0;
}

/**
 * EV Nova Bible, crön First/Last Day/Month/Year: 0 or -1 is a wildcard. With
 * wildcard years the window repeats every year (cron 156, drop bear mating
 * season, 1 Sep - 30 Dec), and a window whose first date is later in the
 * year than its last wraps across New Year.
 */
export function isCronDateEligible(
    cron: Pick<CronData, 'firstDay' | 'firstMonth' | 'firstYear'
        | 'lastDay' | 'lastMonth' | 'lastYear'>,
    date: CalendarDate,
): boolean {
    const first = { year: cron.firstYear, month: cron.firstMonth, day: cron.firstDay };
    const last = { year: cron.lastYear, month: cron.lastMonth, day: cron.lastDay };
    const hasFirst = set(first.year) || set(first.month) || set(first.day);
    const hasLast = set(last.year) || set(last.month) || set(last.day);
    const afterFirst = !hasFirst || compareToBound(date, first) >= 0;
    const beforeLast = !hasLast || compareToBound(date, last) <= 0;
    if (hasFirst && hasLast && !set(first.year) && !set(last.year)) {
        const firstKey = (set(first.month) ? first.month : 0) * 100
            + (set(first.day) ? first.day : 0);
        const lastKey = (set(last.month) ? last.month : 13) * 100
            + (set(last.day) ? last.day : 32);
        if (firstKey > lastKey) {
            return afterFirst || beforeLast;
        }
    }
    return afterFirst && beforeLast;
}

export interface CronAdvanceOptions {
    /**
     * The player's Contribute from ship, outfits and ränks (see
     * loadPlayerContribute). Active crön Contribute is added here. When
     * absent, crons with a nonzero Require never activate.
     */
    contribute?: Bits64;
    /** NCB callbacks (outfits, ship change, sounds...) for set expressions. */
    ncb?: Omit<NcbHandlerContext, 'state'>;
    /** Upper bound on days processed in one call (default 3650). */
    days?: number;
    random?: () => number;
    logger?: (message: string) => void;
}

export interface CronAdvanceResult {
    /** Crön ids whose OnStart ran, once per start, in order. */
    started: string[];
    /** Crön ids whose OnEnd ran, once per end, in order. */
    ended: string[];
    /** Days processed. */
    days: number;
}

function sameCronId(a: string, b: string): boolean {
    return a === b || a.replace(/^.*:/, '') === b.replace(/^.*:/, '');
}

/** Ids of crons whose events are currently running (phase `active`). */
export function activeCronIds(state: Pick<PlayerState, 'crons'>): string[] {
    return (state.crons ?? [])
        .filter(entry => entry.phase === 'active')
        .map(entry => entry.id);
}

class CronDay {
    constructor(
        private readonly crons: readonly CronData[],
        private readonly state: PlayerState,
        private readonly options: CronAdvanceOptions,
        private readonly result: CronAdvanceResult,
    ) { }

    private get logger() {
        return this.options.logger ?? console.warn;
    }

    cronFor(id: string): CronData | undefined {
        return this.crons.find(cron => sameCronId(cron.id, id));
    }

    contribute(): Bits64 {
        const running = (this.state.crons ?? [])
            .filter(entry => entry.phase === 'active')
            .map(entry => this.cronFor(entry.id)?.contribute);
        return orBits(this.options.contribute, ...running);
    }

    private requireMet(cron: CronData): boolean {
        const [high, low] = toBits64(cron.require);
        if (high === 0 && low === 0) return true;
        if (this.options.contribute === undefined) return false;
        return meetsRequire([high, low], this.contribute());
    }

    private enabled(cron: CronData): boolean {
        if (!cron.enableOn?.trim()) return true;
        try {
            return evaluateTestExpression(cron.enableOn,
                ncbTestContext(this.state, this.options.ncb?.outfits));
        } catch (error) {
            this.logger(`Invalid EnableOn for cron ${cron.id}: ${error}`);
            return false;
        }
    }

    /** EnableOn and Require: the "still true" test of the iterative flags. */
    private stillEnabled(cron: CronData): boolean {
        return this.enabled(cron) && this.requireMet(cron);
    }

    eligible(cron: CronData, date: number): boolean {
        if (!isCronDateEligible(cron, getCalendarDate(date))) return false;
        if (!this.stillEnabled(cron)) return false;
        if (cron.random <= 0) return false;
        if (cron.random < 100
            && hashSample(`${cron.id}:${Math.floor(date)}`) >= cron.random) {
            return false;
        }
        return true;
    }

    private run(expression: string | undefined, cron: CronData) {
        if (!expression?.trim()) return;
        try {
            const operations = parseSetExpression(expression, { logger: this.logger });
            executeSetOperations(operations, this.state.missionBits, {
                handlers: createNcbHandlers({
                    ...this.options.ncb,
                    state: this.state,
                    logger: this.logger,
                }),
                random: this.options.random,
                logger: this.logger,
            });
        } catch (error) {
            this.logger(`Could not run cron ${cron.id} expression '${expression}': ${error}`);
        }
    }

    private runRepeating(expression: string, cron: CronData, iterative: boolean) {
        this.run(expression, cron);
        if (!iterative || !expression?.trim()) return;
        for (let i = 1; i < MAX_CRON_ITERATIONS && this.stillEnabled(cron); i++) {
            this.run(expression, cron);
        }
    }

    /**
     * Advance one entry through as many phases as fall due on `date`. Returns
     * false when the entry is deactivated.
     */
    step(entry: CronStateEntry, cron: CronData, date: number): boolean {
        if (entry.phase === 'pending') {
            if (date - entry.since < Math.max(0, cron.preHoldoff)) return true;
            entry.phase = 'active';
            entry.since = date;
            this.runRepeating(cron.onStart, cron,
                (cron.flags & CRON_ITERATIVE_START) !== 0);
            this.result.started.push(cron.id);
        }
        if (entry.phase === 'active') {
            if (date - entry.since < Math.max(0, cron.duration)) return true;
            entry.phase = 'post';
            entry.since = date;
            this.runRepeating(cron.onEnd, cron,
                (cron.flags & CRON_ITERATIVE_END) !== 0);
            this.result.ended.push(cron.id);
        }
        return date - entry.since < Math.max(0, cron.postHoldoff);
    }
}

function processCronDay(day: CronDay, crons: readonly CronData[],
    state: PlayerState, date: number) {
    const touched = new Set<string>();
    const kept: CronStateEntry[] = [];
    for (const entry of [...(state.crons ?? [])]) {
        const cron = day.cronFor(entry.id);
        touched.add(entry.id);
        if (!cron) continue;
        if (day.step(entry, cron, date)) kept.push(entry);
    }
    state.crons = kept;
    for (const cron of crons) {
        if ([...touched].some(id => sameCronId(id, cron.id))) continue;
        if (!day.eligible(cron, date)) continue;
        const entry: CronStateEntry = { id: cron.id, phase: 'pending', since: date };
        state.crons.push(entry);
        touched.add(cron.id);
        if (!day.step(entry, cron, date)) {
            state.crons = state.crons.filter(item => item !== entry);
        }
    }
}

/**
 * Run the crön calendar from the day after `state.cronDate` through
 * `state.gameDate`, one day at a time, so DatePostInc and multi-day jumps
 * still hold each event for its full PreHoldoff/Duration/PostHoldoff.
 *
 * Lifecycle per EV Nova Bible, crön: an eligible event (date window,
 * EnableOn, Require vs Contribute, Random% per day) is activated, waits
 * PreHoldoff days, runs OnStart, stays active for Duration days (contributing
 * its Contribute bits), runs OnEnd, is held PostHoldoff days and is then
 * deactivated and may become eligible again. NCB `S` operations are queued
 * on the pilot; callers should follow with startPendingNcbMissions.
 */
export function advanceCrons(
    crons: readonly CronData[],
    state: PlayerState,
    options: CronAdvanceOptions = {},
): CronAdvanceResult {
    const result: CronAdvanceResult = { started: [], ended: [], days: 0 };
    const today = Math.floor(state.gameDate);
    const maxDays = Math.max(1, Math.floor(options.days ?? MAX_CRON_CATCH_UP_DAYS));
    let from = state.cronDate === undefined ? today : Math.floor(state.cronDate) + 1;
    if (today - from + 1 > maxDays) {
        from = today - maxDays + 1;
    }
    const day = new CronDay(crons, state, options, result);
    for (let date = from; date <= today; date++) {
        processCronDay(day, crons, state, date);
        result.days++;
    }
    if (state.cronDate === undefined || state.cronDate < today) {
        state.cronDate = today;
    }
    return result;
}
