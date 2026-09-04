import "jasmine";
import { getDefaultCronData, CronData } from "novadatainterface/CronData";
import { createInitialPlayerState } from "./player_state";
import {
    evaluateCrons,
    getCalendarDate,
    isCronDateEligible,
} from "./cron_plugin";

describe("cron_plugin", () => {
    it("maps retail starting gameDate 0 to 18 October 1177", () => {
        const date = getCalendarDate(0);
        expect(date.day).toBe(18);
        expect(date.month).toBe(10);
        expect(date.year).toBe(1177);
    });

    it("checks date eligibility with wildcards and bounds", () => {
        const cron: CronData = {
            ...getDefaultCronData(),
            firstYear: 1180,
            firstMonth: 5,
            firstDay: 1,
            lastYear: 1185,
            lastMonth: 12,
            lastDay: 31,
        };

        expect(isCronDateEligible(cron, { day: 18, month: 10, year: 1177 })).toBe(false);
        expect(isCronDateEligible(cron, { day: 1, month: 5, year: 1180 })).toBe(true);
        expect(isCronDateEligible(cron, { day: 15, month: 6, year: 1182 })).toBe(true);
        expect(isCronDateEligible(cron, { day: 1, month: 1, year: 1186 })).toBe(false);
    });

    it("fires cron events and executes onStart and onEnd set expressions", () => {
        const state = createInitialPlayerState();
        // Give state required bit b100
        state.missionBits[100] = true;

        const cron1: CronData = {
            ...getDefaultCronData(),
            id: "nova:1001",
            enableOn: "b100 & !b101",
            onStart: "b101",
            duration: 0,
        };

        const result = evaluateCrons([cron1], state);
        expect(result.executedStarts).toContain("nova:1001");
        expect(state.missionBits[101]).toBe(true);

        // Subsequent evaluation does not re-fire because !b101 is now false
        const repeat = evaluateCrons([cron1], state);
        expect(repeat.executedStarts.length).toBe(0);
    });

    it("handles duration-based active crons and executes onEnd when expired", () => {
        const state = createInitialPlayerState();
        state.gameDate = 10;

        const cronWithDuration: CronData = {
            ...getDefaultCronData(),
            id: "nova:1002",
            enableOn: "!b201",
            onStart: "b200",
            onEnd: "b201 !b200",
            duration: 5,
        };

        // Day 10: onStart fires, activeCron created
        const step1 = evaluateCrons([cronWithDuration], state, []);
        expect(step1.executedStarts).toContain("nova:1002");
        expect(state.missionBits[200]).toBe(true);
        expect(state.missionBits[201]).toBeFalsy();
        expect(step1.activeCrons.length).toBe(1);

        // Day 12: not yet expired (needs date >= 15)
        state.gameDate = 12;
        const step2 = evaluateCrons([cronWithDuration], state, step1.activeCrons);
        expect(step2.executedEnds.length).toBe(0);
        expect(step2.activeCrons.length).toBe(1);

        // Day 15: expired! onEnd fires
        state.gameDate = 15;
        const step3 = evaluateCrons([cronWithDuration], state, step2.activeCrons);
        expect(step3.executedEnds).toContain("nova:1002");
        expect(state.missionBits[201]).toBe(true);
        expect(state.missionBits[200]).toBe(false);
        expect(step3.activeCrons.length).toBe(0);
    });
});
