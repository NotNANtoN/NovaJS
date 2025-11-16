import { BaseData, getDefaultBaseData } from "./BaseData.js";

export interface CicnData extends BaseData { }

export function getDefaultCicnData(): CicnData {
    return getDefaultBaseData();
}
