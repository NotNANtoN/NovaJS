import { CronResource } from "../resource_parsers/CronResource";
import { CronData } from "novadatainterface/CronData";
import { BaseData } from "novadatainterface/BaseData";
import { BaseParse } from "./BaseParse";

export async function CronParse(
    cron: CronResource,
    notFoundFunction: (m: string) => void,
): Promise<CronData> {
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
        indNewsStr: cron.indNewsStr,
        flags: cron.flags,
        enableOn: cron.enableOn,
        onStart: cron.onStart,
        onEnd: cron.onEnd,
        contribute: cron.contribute,
        require: cron.require,
        newsGovt: cron.newsGovt,
        govtNewsStr: cron.govtNewsStr,
    };
}
