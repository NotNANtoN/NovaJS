import { CronData } from "novadatainterface/cron_data";
import { BaseData } from "novadatainterface/base_data";
import { CronResource } from "../resource_parsers/cron_resource.js";
import { BaseParse } from "./base_parse.js";
import { FlagNamespaceMap, resolveResourceFlags } from "../flag_namespace.js";

/**
 * Maps a parsed crön resource onto the CronData shape. A straight
 * projection: the resource parser already decodes the flag words, and
 * the contribute/require sets become decimal strings so the data stays
 * JSON-serializable over the HTTP data route. The sets are namespaced
 * per plug-in (flag_namespace.ts), so they may exceed 64 bits.
 */
export async function CronParse(cron: CronResource,
    notFoundFunction: (m: string) => void,
    flagMap: FlagNamespaceMap | null = null): Promise<CronData> {
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
        contribute: resolveResourceFlags(flagMap, cron, cron.contribute).toString(),
        require: resolveResourceFlags(flagMap, cron, cron.require).toString(),
        indNews: newsStrings(cron, cron.indNewsStr),
        govtNews: cron.govtNews.flatMap(({ govt, newsStr }) => {
            const govtResource = cron.idSpace.gövt[govt];
            if (!govtResource) {
                notFoundFunction(`No gövt ${govt} for crön ${base.id} news`);
                return [];
            }
            const strings = newsStrings(cron, newsStr);
            return strings.length > 0
                ? [{ govt: govtResource.globalID, strings }] : [];
        }),
    };
}

/**
 * Resolves a STR# id to its (non-empty) strings. The Bible allows a
 * positive-but-missing STR# id (used to suppress independent news),
 * which comes out here as an empty list.
 */
function newsStrings(cron: CronResource, strId: number): string[] {
    if (strId <= 0) {
        return [];
    }
    const list = cron.idSpace["STR#"][strId];
    return list?.strings.filter(s => s.trim().length > 0) ?? [];
}
