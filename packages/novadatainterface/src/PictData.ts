import { BaseData, getDefaultBaseData } from "./BaseData.js";

export interface PictData extends BaseData { }

export function getDefaultPictData(): PictData {
    return getDefaultBaseData();
}
