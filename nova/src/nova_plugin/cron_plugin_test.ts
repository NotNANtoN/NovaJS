import "jasmine";
import { NovaDataType } from "novadatainterface/NovaDataInterface";
import { getDefaultCronData, CronData } from "novadatainterface/CronData";
import { createInitialPlayerState, PlayerState } from "./player_state";
import {
    activeCronIds,
    advanceCrons,
    getCalendarDate,
    isCronDateEligible,
} from "./cron_plugin";
import { takePendingMissionStarts } from "./ncb_handlers";
import { retailDataPath, skipWithoutRetailData, hasRetailData } from "../../../test/retail_data";

function cron(fields: Partial<CronData>): CronData {
    return { ...getDefaultCronData(), id: "nova:1000", ...fields };
}

/** Advance the game date one day at a time, running the cron engine. */
function runDays(crons: CronData[], state: PlayerState, days: number,
    options: Parameters<typeof advanceCrons>[2] = {}) {
    const started: string[] = [];
    const ended: string[] = [];
    for (let i = 0; i < days; i++) {
        state.gameDate += 1;
        const result = advanceCrons(crons, state, options);
        started.push(...result.started);
        ended.push(...result.ended);
    }
    return { started, ended };
}

describe("cron_plugin", () => {
    it("maps retail starting gameDate 0 to 18 October 1177", () => {
        const date = getCalendarDate(0);
        expect(date.day).toBe(18);
        expect(date.month).toBe(10);
        expect(date.year).toBe(1177);
    });

    it("checks date eligibility with wildcards and bounds", () => {
        const window = cron({
            firstYear: 1180, firstMonth: 5, firstDay: 1,
            lastYear: 1185, lastMonth: 12, lastDay: 31,
        });
        expect(isCronDateEligible(window, { day: 18, month: 10, year: 1177 })).toBe(false);
        expect(isCronDateEligible(window, { day: 1, month: 5, year: 1180 })).toBe(true);
        expect(isCronDateEligible(window, { day: 15, month: 6, year: 1182 })).toBe(true);
        expect(isCronDateEligible(window, { day: 1, month: 1, year: 1186 })).toBe(false);
    });

    it("repeats a wildcard-year window every year and wraps over New Year", () => {
        const season = cron({ firstDay: 1, firstMonth: 9, firstYear: -1,
            lastDay: 30, lastMonth: 12, lastYear: -1 });
        expect(isCronDateEligible(season, { day: 31, month: 8, year: 1180 })).toBe(false);
        expect(isCronDateEligible(season, { day: 1, month: 9, year: 1180 })).toBe(true);
        expect(isCronDateEligible(season, { day: 30, month: 12, year: 1190 })).toBe(true);
        expect(isCronDateEligible(season, { day: 31, month: 12, year: 1190 })).toBe(false);
        const winter = cron({ firstDay: 1, firstMonth: 11, lastDay: 28, lastMonth: 2 });
        expect(isCronDateEligible(winter, { day: 5, month: 1, year: 1181 })).toBe(true);
        expect(isCronDateEligible(winter, { day: 5, month: 6, year: 1181 })).toBe(false);
        expect(isCronDateEligible(winter, { day: 5, month: 12, year: 1181 })).toBe(true);
    });

    it("runs OnStart and OnEnd the same day for Duration 0", () => {
        const state = createInitialPlayerState();
        state.missionBits[100] = true;
        const once = cron({ enableOn: "b100 & !b102", onStart: "b101", onEnd: "b102" });
        const result = advanceCrons([once], state);
        expect(result.started).toEqual(["nova:1000"]);
        expect(result.ended).toEqual(["nova:1000"]);
        expect(state.missionBits[101]).toBe(true);
        expect(state.missionBits[102]).toBe(true);
        expect(state.crons).toEqual([]);
        // EnableOn is false now, so it never fires again.
        expect(runDays([once], state, 5).started).toEqual([]);
    });

    it("waits PreHoldoff, stays active for Duration, then holds PostHoldoff", () => {
        const state = createInitialPlayerState();
        const event = cron({ preHoldoff: 3, duration: 5, postHoldoff: 2,
            onStart: "b200", onEnd: "!b200 ^b201", contribute: [0, 0x40] });
        advanceCrons([event], state);
        expect(state.crons).toEqual([{ id: "nova:1000", phase: "pending", since: 0 }]);

        runDays([event], state, 2);
        expect(state.missionBits[200]).toBeFalsy();
        runDays([event], state, 1); // day 3
        expect(state.missionBits[200]).toBe(true);
        expect(activeCronIds(state)).toEqual(["nova:1000"]);

        runDays([event], state, 4); // day 7
        expect(state.missionBits[201]).toBeFalsy();
        runDays([event], state, 1); // day 8
        expect(state.missionBits[200]).toBe(false);
        expect(state.missionBits[201]).toBe(true);
        expect(state.crons?.[0]?.phase).toBe("post");

        runDays([event], state, 1); // day 9, still held
        expect(state.crons?.length).toBe(1);
        // Day 10: deactivated; eligible again from the next day.
        runDays([event], state, 1);
        expect(state.crons).toEqual([]);
        runDays([event], state, 1);
        expect(state.crons).toEqual([{ id: "nova:1000", phase: "pending", since: 11 }]);
    });

    it("processes each day of a multi-day jump", () => {
        const state = createInitialPlayerState();
        advanceCrons([], state);
        const event = cron({ preHoldoff: 2, duration: 3, onStart: "b300", onEnd: "b301" });
        state.gameDate = 1;
        advanceCrons([event], state);
        state.gameDate = 40;
        const result = advanceCrons([event], state);
        expect(result.days).toBe(39);
        expect(state.missionBits[300]).toBe(true);
        expect(state.missionBits[301]).toBe(true);
        // Activated day 1, starts day 3, ends day 6, re-activated day 7:
        // starts on days 3, 9, 15, 21, 27, 33, 39.
        expect(result.started.length).toBe(7);
        expect(state.cronDate).toBe(40);
    });

    it("gates Require on the player's Contribute including active crons", () => {
        const state = createInitialPlayerState();
        const provider = cron({ id: "nova:1", duration: 10, contribute: [0x1, 0] });
        const dependent = cron({ id: "nova:2", require: [0x1, 0], onStart: "b400" });
        advanceCrons([dependent], state);
        expect(state.missionBits[400]).toBeFalsy();

        state.gameDate = 1;
        advanceCrons([provider, dependent], state, { contribute: [0, 0] });
        // Same-day: dependent is examined after provider became active.
        expect(state.missionBits[400]).toBe(true);

        const other = createInitialPlayerState();
        advanceCrons([dependent], other, { contribute: [0x1, 0] });
        expect(other.missionBits[400]).toBe(true);
    });

    it("applies Random as a deterministic daily percentage", () => {
        const never = cron({ random: 0, onStart: "b500" });
        const state = createInitialPlayerState();
        runDays([never], state, 30);
        expect(state.missionBits[500]).toBeFalsy();

        const sometimes = cron({ random: 20, onStart: "b501", onEnd: "!b501" });
        const counts = runDays([sometimes], createInitialPlayerState(), 500).started.length;
        expect(counts).toBeGreaterThan(40);
        expect(counts).toBeLessThan(180);
    });

    it("keeps re-running OnStart while EnableOn holds for Flags 0x0001", () => {
        // Pass 1 sets b10 and clears b11 (EnableOn still true); pass 2
        // clears b10 and EnableOn fails. A single run would leave b10 set.
        const make = (flags: number) => cron({
            flags, enableOn: "b10 | b11", onStart: "^b10 !b11",
        });
        const state = createInitialPlayerState();
        state.missionBits[11] = true;
        advanceCrons([make(0x0001)], state);
        expect(state.missionBits[10]).toBe(false);
        expect(state.missionBits[11]).toBe(false);

        const single = createInitialPlayerState();
        single.missionBits[11] = true;
        advanceCrons([make(0)], single);
        expect(single.missionBits[10]).toBe(true);

        // Unbounded loops stop at the iteration limit.
        const forever = cron({ flags: 0x0002, onEnd: "^b13" });
        const other = createInitialPlayerState();
        expect(() => advanceCrons([forever], other)).not.toThrow();
    });

    it("executes G/D and queues S through NCB handlers", () => {
        const state = createInitialPlayerState();
        state.missionBits[9011] = true;
        const outfits = new Map([["nova:358", { count: 1 }]]);
        const knockoff = cron({
            enableOn: "b9011 & o358", onStart: "d358 R(g374 g261) S700",
            onEnd: "!b9011",
        });
        advanceCrons([knockoff], state, { ncb: { outfits }, random: () => 0 });
        expect(outfits.has("nova:358")).toBe(false);
        expect(outfits.get("nova:374")?.count).toBe(1);
        expect(state.missionBits[9011]).toBe(false);
        expect(takePendingMissionStarts(state)).toEqual([700]);
    });

    describe("retail crons", () => {
        let crons: Map<string, CronData> | undefined;

        beforeAll(async () => {
            if (!hasRetailData()) return;
            const { NovaParse } = await import("../../../novaparse/NovaParse");
            const parser = new NovaParse(retailDataPath(), false);
            crons = new Map();
            for (const id of [156, 158, 209, 383]) {
                crons.set(String(id), await parser.data[NovaDataType.Cron]!.get(`nova:${id}`));
            }
        }, 120000);

        it("cron 209 Brass Improvement sets b6300 after its holdoff and duration", () => {
            if (skipWithoutRetailData()) return;
            const brass = crons!.get("209")!;
            const state = createInitialPlayerState();
            state.missionBits[130] = true;
            advanceCrons([brass], state);
            const days = runDays([brass], state, 400);
            expect(state.missionBits[6300]).toBe(true);
            expect(days.ended).toEqual([brass.id]);
            // Random 75% per day delays activation a little; PreHoldoff 100 +
            // Duration 50 make 150 days the minimum.
            const pending = createInitialPlayerState();
            pending.missionBits[130] = true;
            advanceCrons([brass], pending);
            runDays([brass], pending, 149);
            expect(pending.missionBits[6300]).toBeFalsy();
            runDays([brass], pending, 20);
            expect(pending.missionBits[6300]).toBe(true);
        });

        it("cron 383 Thunderforge sets b167 after 90 days", () => {
            if (skipWithoutRetailData()) return;
            const thunderforge = crons!.get("383")!;
            const state = createInitialPlayerState();
            state.missionBits[166] = true;
            advanceCrons([thunderforge], state);
            runDays([thunderforge], state, 89);
            expect(state.missionBits[167]).toBeFalsy();
            runDays([thunderforge], state, 1);
            expect(state.missionBits[167]).toBe(true);
        });

        it("cron 158 swaps b750 for b749 at its end", () => {
            if (skipWithoutRetailData()) return;
            const cloak = crons!.get("158")!;
            const state = createInitialPlayerState();
            state.missionBits[199] = true;
            advanceCrons([cloak], state);
            runDays([cloak], state, 365);
            expect(state.missionBits[750]).toBe(true);
            runDays([cloak], state, 180);
            expect(state.missionBits[750]).toBe(false);
            expect(state.missionBits[749]).toBe(true);
        });

        it("cron 156 drop bear season starts on 1 September", () => {
            if (skipWithoutRetailData()) return;
            const bears = crons!.get("156")!;
            const state = createInitialPlayerState();
            advanceCrons([bears], state); // 18 Oct 1177: in season
            expect(state.missionBits[42]).toBe(true);
            // 105 days later it ends (31 Jan 1178) and the window is closed.
            runDays([bears], state, 105);
            expect(state.missionBits[42]).toBe(false);
            const date = getCalendarDate(state.gameDate);
            expect([date.month, date.day]).toEqual([1, 31]);
            // Stays off until 1 September 1178.
            while (!(getCalendarDate(state.gameDate + 1).month === 9
                && getCalendarDate(state.gameDate + 1).day === 1)) {
                runDays([bears], state, 1);
                expect(state.missionBits[42]).toBe(false);
            }
            runDays([bears], state, 1);
            expect(state.missionBits[42]).toBe(true);
        });
    });
});
