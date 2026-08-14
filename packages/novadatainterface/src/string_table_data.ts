import { BaseData, getDefaultBaseData } from "./base_data.js";

/**
 * A list of user-visible strings (a STR# resource). Other resources index
 * into these by list position: ship names, hail and comm quotes, cargo types,
 * stellar-type descriptions, and most of the game's fixed UI text.
 */
export interface StringTableData extends BaseData {
    /** The strings in list order; index 0 is the resource's "first string". */
    strings: string[];
}

export function getDefaultStringTableData(): StringTableData {
    return {
        ...getDefaultBaseData(),
        strings: [],
    };
}
