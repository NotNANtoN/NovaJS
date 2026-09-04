import { RankResource } from "../resource_parsers/RankResource";
import { RankData } from "novadatainterface/RankData";
import { BaseData } from "novadatainterface/BaseData";
import { BaseParse } from "./BaseParse";

export async function RankParse(
    rank: RankResource,
    notFoundFunction: (m: string) => void,
): Promise<RankData> {
    const base: BaseData = await BaseParse(rank, notFoundFunction);
    return {
        ...base,
        weight: rank.weight,
        government: rank.government,
        salary: rank.salary,
        salaryCap: rank.salaryCap,
        contribute: rank.contribute,
        flags: rank.flags,
        convName: rank.convName,
        shortName: rank.shortName,
    };
}
