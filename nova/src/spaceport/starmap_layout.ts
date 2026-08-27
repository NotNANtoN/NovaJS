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

const FRAME_LEFT = -MAP_WELL.frame.x / 2;
const FRAME_TOP = -MAP_WELL.frame.y / 2;
const FRAME_RIGHT = MAP_WELL.frame.x / 2;
const FRAME_BOTTOM = MAP_WELL.frame.y / 2;
const WELL_ORIGIN = mapWellOrigin();
const WELL_RIGHT = WELL_ORIGIN.x + MAP_WELL.size.x;
const WELL_BOTTOM = WELL_ORIGIN.y + MAP_WELL.size.y;

/**
 * Text slots measured from PICT 8509. The right column starts just beyond the
 * map bevel; the bottom slots stay inside the metal strip and leave room for
 * the date at its right edge.
 */
export const STARMAP_LAYOUT = {
    rightColumn: {
        x: WELL_RIGHT + 14,
        y: FRAME_TOP + 12,
        width: FRAME_RIGHT - (WELL_RIGHT + 14) - 12,
        height: WELL_BOTTOM - (FRAME_TOP + 12) - 12,
    },
    rightHeading: {
        x: WELL_RIGHT + 14,
        y: FRAME_TOP + 12,
        width: FRAME_RIGHT - (WELL_RIGHT + 14) - 12,
        height: 18,
    },
    rightBody: {
        x: WELL_RIGHT + 14,
        y: FRAME_TOP + 30,
        width: FRAME_RIGHT - (WELL_RIGHT + 14) - 12,
        height: WELL_BOTTOM - (FRAME_TOP + 30) - 12,
    },
    bottomFacts: {
        x: FRAME_LEFT + 14,
        y: WELL_BOTTOM + 9,
        width: 325,
        height: FRAME_BOTTOM - (WELL_BOTTOM + 9) - 10,
    },
    date: {
        x: FRAME_RIGHT - 158,
        y: FRAME_BOTTOM - 24,
        width: 146,
        height: 16,
    },
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
