import { getDefaultTargetCornersData, TargetCornersData } from "novadatainterface/TargetCornersData";
import { BaseResource } from "../resource_parsers/NovaResourceBase.js";


export async function TargetCornersParse(_base: BaseResource, _notFoundFunction: (m: string) => void): Promise<TargetCornersData> {
    // TODO: Actually parse cicns
    return getDefaultTargetCornersData();
};
