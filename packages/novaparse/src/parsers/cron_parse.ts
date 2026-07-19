import { CronData } from "novadatainterface/cron_data";
import { BaseData } from "novadatainterface/base_data";
import { CronResource } from "../resource_parsers/cron_resource.js";
import { BaseParse } from "./base_parse.js";

/**
 * Maps a parsed crön resource onto the CronData shape. A straight
 * projection: the resource parser already decodes the flag words, and
 * the 64-bit contribute/require sets become decimal strings so the
 * data stays JSON-serializable over the HTTP data route.
 */
export async function CronParse(cron: CronResource,
    notFoundFunction: (m: string) => void): Promise<CronData> {
    const base: BaseData = await BaseParse(cron, notFoundFunction);

    return {
        ...base,
        firstDay: cron.firstDay,
        firstMonth: cron.firstMonth,
        firstYear: cron.firstYear,
        lastDay: cron.lastDay,
        lastMonth: cron.lastMonth,
        lastYear: cron.lastYear,
        random: cron.random,
        duration: cron.duration,
        preHoldoff: cron.preHoldoff,
        postHoldoff: cron.postHoldoff,
        loopOnStart: cron.loopOnStart,
        loopOnEnd: cron.loopOnEnd,
        enableOn: cron.enableOn,
        onStart: cron.onStart,
        onEnd: cron.onEnd,
        contribute: cron.contribute.toString(),
        require: cron.require.toString(),
    };
}
