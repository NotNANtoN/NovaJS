import { BaseData, getDefaultBaseData } from "./base_data.js";

export interface CicnData extends BaseData { }

export function getDefaultCicnData(): CicnData {
    return getDefaultBaseData();
}
