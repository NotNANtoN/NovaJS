import { OopsResource } from "../resource_parsers/OopsResource";
import { OopsData } from "novadatainterface/OopsData";
import { BaseData } from "novadatainterface/BaseData";
import { BaseParse } from "./BaseParse";

export async function OopsParse(
    oops: OopsResource,
    notFoundFunction: (m: string) => void,
): Promise<OopsData> {
    const base: BaseData = await BaseParse(oops, notFoundFunction);
    return {
        ...base,
        stellar: oops.stellar,
        commodity: oops.commodity,
        priceDelta: oops.priceDelta,
        duration: oops.duration,
        freq: oops.freq,
        activateOn: oops.activateOn,
    };
}
