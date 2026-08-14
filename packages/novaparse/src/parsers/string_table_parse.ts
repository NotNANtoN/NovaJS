import { BaseData } from "novadatainterface/base_data";
import { StringTableData } from "novadatainterface/string_table_data";
import { StrNResource } from "../resource_parsers/strn_resource.js";
import { BaseParse } from "./base_parse.js";

/**
 * Projects a parsed STR# resource onto StringTableData. The strings are
 * already plain JavaScript strings by the time they get here (the resource
 * parser decodes MacRoman), so this is a straight passthrough that keeps
 * list order — callers index into it by list position.
 */
export async function StringTableParse(strn: StrNResource, notFoundFunction: (m: string) => void): Promise<StringTableData> {
    const base: BaseData = await BaseParse(strn, notFoundFunction);

    return {
        ...base,
        strings: [...strn.strings],
    };
}
