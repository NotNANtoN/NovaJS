import { BaseData, getDefaultBaseData } from "./base_data.js";

/**
 * A crön: a timed, invisible event that manipulates control bits at
 * random or fixed points as the game date advances. Semantics follow
 * the EVN Bible's crön section.
 */
export interface CronData extends BaseData {
    /** First day (1-31) the event can activate; 0/-1 any. */
    firstDay: number;
    /** First month (1-12) the event can activate; 0/-1 any. */
    firstMonth: number;
    /** First year the event can activate; 0/-1 any. */
    firstYear: number;
    /** Last day (1-31) the event can activate; 0/-1 any. */
    lastDay: number;
    /** Last month (1-12) the event can activate; 0/-1 any. */
    lastMonth: number;
    /** Last year the event can activate; 0/-1 any. */
    lastYear: number;
    /** Percent chance per day of activating in range; 100 = ASAP. */
    random: number;
    /** Days the event stays active; 0 = OnStart and OnEnd together. */
    duration: number;
    /** Days between activation and OnStart running. */
    preHoldoff: number;
    /** Days after the event ends before it may activate again. */
    postHoldoff: number;
    /** Re-run OnStart daily while active until its conditions fail. */
    loopOnStart: boolean;
    /** Re-run OnEnd daily after ending until its conditions fail. */
    loopOnEnd: boolean;
    /** NCB test expression gating whether the event may activate. */
    enableOn: string;
    /** NCB set expression run when the event starts. */
    onStart: string;
    /** NCB set expression run when the event ends. */
    onEnd: string;
    /**
     * 64-bit Contribute flags granted while active, as a decimal
     * string (JSON-safe; parse with BigInt()).
     */
    contribute: string;
    /**
     * 64-bit Require flags and'ed against the player's Contribute bits
     * to activate, as a decimal string.
     */
    require: string;
    /**
     * Independent news: the strings of the crön's IndNewsStr STR#
     * resource, one of which shows in the bar news dialog while the
     * event is active on stellars with no matching local news.
     * Resolved from the STR# at parse time so consumers don't need a
     * string-list data type.
     */
    indNews: string[];
    /**
     * Local news: up to four govt-specific news string lists
     * (NewsGovt/GovtNewsStr pairs), keyed by the gövt's global id.
     * Shown while the event is active on stellars of that government
     * (and, in the original, its allies). Local news beats independent
     * news.
     */
    govtNews: { govt: string, strings: string[] }[];
}

export function getDefaultCronData(): CronData {
    return {
        ...getDefaultBaseData(),
        firstDay: 0,
        firstMonth: 0,
        firstYear: 0,
        lastDay: 0,
        lastMonth: 0,
        lastYear: 0,
        random: 100,
        duration: 0,
        preHoldoff: 0,
        postHoldoff: 0,
        loopOnStart: false,
        loopOnEnd: false,
        enableOn: "",
        onStart: "",
        onEnd: "",
        contribute: "0",
        require: "0",
        indNews: [],
        govtNews: [],
    };
}
