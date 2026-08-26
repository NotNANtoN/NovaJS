import { StringListData } from "novadatainterface/StringListData";
import { StrhResource } from "../resource_parsers/StrhResource";
import { BaseParse } from "./BaseParse";

export async function StringListParse(
    strh: StrhResource,
    notFoundFunction: (message: string) => void,
): Promise<StringListData> {
    const base = await BaseParse(strh, notFoundFunction);
    return {
        ...base,
        strings: [...strh.strings],
    };
}
