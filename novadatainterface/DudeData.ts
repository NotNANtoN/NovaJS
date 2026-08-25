import { BaseData, getDefaultBaseData } from './BaseData';

export interface DudeShipType {
    id: string;
    weight: number;
}

export interface DudeData extends BaseData {
    aiType: number;
    government: number;
    flags: number;
    infoTypes: number;
    ships: DudeShipType[];
}

export function getDefaultDudeData(): DudeData {
    return {
        ...getDefaultBaseData(),
        aiType: 0,
        government: -1,
        flags: 0,
        infoTypes: 0,
        ships: [],
    };
}
