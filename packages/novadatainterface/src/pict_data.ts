import { BaseData, getDefaultBaseData } from "./base_data.js";

export interface PictData extends BaseData { }

export function getDefaultPictData(): PictData {
    return getDefaultBaseData();
}
