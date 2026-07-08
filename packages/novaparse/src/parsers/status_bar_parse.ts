import { BaseResource } from "../resource_parsers/nova_resource_base.js";
import { StatusBarData, getDefaultStatusBarColors, getDefaultStatusBarDataAreas } from "novadatainterface/status_bar_data";
import { BaseParse } from "./base_parse.js";
import { BaseData } from "novadatainterface/base_data";


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
