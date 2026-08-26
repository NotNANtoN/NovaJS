/**
 * The map well inside the retail `PICT` 8509 frame. The frame is 601x513 and
 * is drawn centred on the menu origin. The well is the area enclosed by the
 * frame's bevel highlight, measured from the artwork at x=5..467 and
 * y=4..429; the darker strips to its right and below it are frame, not map.
 */
export const MAP_WELL = {
    frame: { x: 601, y: 513 },
    inset: { x: 5, y: 4 },
    size: { x: 462, y: 425 },
} as const;

export interface MapWell {
    frame: { x: number; y: number };
    inset: { x: number; y: number };
    size: { x: number; y: number };
}

/** Where the map well sits relative to the centred frame. */
export function mapWellOrigin(well: MapWell = MAP_WELL) {
    return {
        x: -well.frame.x / 2 + well.inset.x,
        y: -well.frame.y / 2 + well.inset.y,
    };
}
