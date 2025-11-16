import { BaseResource } from "../resource_parsers/NovaResourceBase.js";
import { StatusBarData, getDefaultStatusBarColors, getDefaultStatusBarDataAreas } from "novadatainterface/StatusBarData";
import { BaseParse } from "./BaseParse.js";
import { BaseData } from "novadatainterface/BaseData";


export async function StatusBarParse(baseResource: BaseResource, notFoundFunction: (m: string) => void): Promise<StatusBarData> {
    var base: BaseData = await BaseParse(baseResource, notFoundFunction);

    // TODO: Parse statusbars
    return {
        ...base,
        image: "nova:700", // The default civilian status bar.
        colors: getDefaultStatusBarColors(),
        dataAreas: getDefaultStatusBarDataAreas()
    }
}
