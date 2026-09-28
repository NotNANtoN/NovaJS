import { CharResource } from "../resource_parsers/CharResource";
import { CharData } from "novadatainterface/CharData";
import { BaseData } from "novadatainterface/BaseData";
import { BaseParse } from "./BaseParse";

export async function CharParse(
    char: CharResource,
    notFoundFunction: (m: string) => void,
): Promise<CharData> {
    const base: BaseData = await BaseParse(char, notFoundFunction);
    return {
        ...base,
        cash: char.cash,
        shipType: char.shipType,
        systems: [...char.systems],
        governments: [...char.governments],
        status: [...char.status],
        kills: char.kills,
        introPicts: [...char.introPicts],
        introPictDelays: [...char.introPictDelays],
        introText: char.introText,
        onStart: char.onStart,
        flags: char.flags,
        startDay: char.startDay,
        startMonth: char.startMonth,
        startYear: char.startYear,
        datePrefix: char.datePrefix,
        dateSuffix: char.dateSuffix,
    };
}
