import { BaseData, getDefaultBaseData } from "./BaseData";

/**
 * A nebula drawn as background artwork on the galaxy map.
 *
 * Retail stores the position and size in galaxy map coordinates, the same
 * space that sÿst resources use, and supplies three pre-scaled PICTs so the
 * artwork stays sharp at each of the map's zoom levels.
 */
export interface NebulaData extends BaseData {
    position: { x: number, y: number };
    size: { x: number, y: number };
    images: {
        zoom25: string | null,
        zoom50: string | null,
        zoom100: string | null,
    };
}

export function getDefaultNebulaData(): NebulaData {
    return {
        ...getDefaultBaseData(),
        position: { x: 0, y: 0 },
        size: { x: 0, y: 0 },
        images: { zoom25: null, zoom50: null, zoom100: null },
    };
}
