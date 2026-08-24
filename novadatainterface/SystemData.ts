import { BaseData, getDefaultBaseData } from "./BaseData";


export interface SystemData extends BaseData {
    position: [number, number],
    links: Array<string>,
    planets: Array<string>,
    dudes: Array<{ id: string, weight: number }>,
    avgShips: number
}

export function getDefaultSystemData(): SystemData {
    return {
        ...getDefaultBaseData(),
        position: [0, 0],
        links: [],
        planets: [],
        dudes: [],
        avgShips: 0
    };
}
