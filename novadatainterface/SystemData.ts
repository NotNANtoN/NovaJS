import { BaseData, getDefaultBaseData } from "./BaseData";


export interface NpcShipSpawnData {
    id: string,
    weight: number,
}

export interface NpcSpawnData {
    id: string,
    weight: number,
    government: number,
    /**
     * Derived from düde AIType (warship/interceptor) or flët provenance.
     * Missing values from older generated data remain personal-only.
     */
    combatRole?: "civilian" | "military" | "personal",
    ships: Array<NpcShipSpawnData>,
}

export interface SystemData extends BaseData {
    position: [number, number],
    links: Array<string>,
    planets: Array<string>,
    // Kept as the compact table for compatibility with existing consumers.
    dudes: Array<{ id: string, weight: number }>,
    // Normalized düde/flët data used by server-side NPC population.
    npcs: Array<NpcSpawnData>,
    avgShips: number,
    /** Raw controlling government ID; -1 means independent. */
    government?: number,
}

export function getDefaultSystemData(): SystemData {
    return {
        ...getDefaultBaseData(),
        position: [0, 0],
        links: [],
        planets: [],
        dudes: [],
        npcs: [],
        avgShips: 0,
        government: -1,
    };
}
