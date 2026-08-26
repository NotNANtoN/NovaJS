import { BaseData, getDefaultBaseData } from "./BaseData";

/**
 * One retail `STR#` list. Nova stores several user-visible word ladders this
 * way, so the engine can show the game's own wording instead of inventing it.
 */
export interface StringListData extends BaseData {
    strings: string[];
}

export function getDefaultStringListData(): StringListData {
    return {
        ...getDefaultBaseData(),
        strings: [],
    };
}
