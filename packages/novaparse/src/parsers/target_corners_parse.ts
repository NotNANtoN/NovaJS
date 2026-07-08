import { getDefaultTargetCornersData, TargetCornersData } from "novadatainterface/target_corners_data";
import { BaseResource } from "../resource_parsers/nova_resource_base.js";


export async function TargetCornersParse(_base: BaseResource, _notFoundFunction: (m: string) => void): Promise<TargetCornersData> {
    // TODO: Actually parse cicns
    return getDefaultTargetCornersData();
};
