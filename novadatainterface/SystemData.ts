import { BaseData, getDefaultBaseData } from "./BaseData";


export interface NpcShipSpawnData {
    id: string,
    weight: number,
}

export interface NpcFleetEscortSpawnData extends NpcShipSpawnData {
    min: number,
    max: number,
}

/**
 * The normalized roster carried by a flët spawn entry. `ships` remains on
 * NpcSpawnData for older consumers; this additive field is what lets an
 * authoritative spawner create one leader and its rolled escorts together.
 */
export interface NpcFleetSpawnData {
    leader: NpcShipSpawnData,
    escorts: Array<NpcFleetEscortSpawnData>,
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
    /**
     * Which resource this entry came from. Booty when boarded is a düde
     * property, so a ship needs to know whether its id names one. Older
     * generated data omits it and yields nothing when plundered.
     */
    kind?: "dude" | "fleet",
    /** Present for flët entries; absent for ordinary düde entries. */
    fleet?: NpcFleetSpawnData,
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
    /** Density of the system's asteroid belt, 0 through 10. */
    asteroidDensity: number,
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
        asteroidDensity: 0,
    };
}
