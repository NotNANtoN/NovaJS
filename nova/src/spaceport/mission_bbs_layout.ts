/**
 * All rectangles below were measured from the retail artwork by locating
 * its opaque black slots, so text lands inside a slot rather than on the
 * surrounding metal.
 */
export interface MissionPanelLayout {
    background: string;
    width: number;
    height: number;
    header: { x: number; y: number; width: number; height: number };
    /** Retail 8517 has a second, right-hand title slot. */
    detailHeader?: { x: number; y: number; width: number; height: number };
    list: { x: number; y: number; width: number; height: number };
    detail?: { x: number; y: number; width: number; height: number };
    footerY: number;
}

// Slots: header 10,2 400x17; list 6,26 214x148; detail title 225,26 279x29;
// detail 225,57 279x97.
export const MISSION_BBS_LAYOUT: MissionPanelLayout = {
    background: 'nova:8505',
    width: 510,
    height: 201,
    header: { x: 12, y: 4, width: 396, height: 15 },
    detailHeader: { x: 229, y: 30, width: 271, height: 22 },
    list: { x: 10, y: 30, width: 206, height: 140 },
    detail: { x: 229, y: 60, width: 271, height: 91 },
    footerY: 176,
};

// Slots: list title 7,2 197x13; detail title 340,3 124x12;
// list 6,20 198x88; detail 210,20 254x99.
export const MISSION_INFO_LAYOUT: MissionPanelLayout = {
    background: 'nova:8517',
    width: 471,
    height: 155,
    header: { x: 9, y: 2, width: 193, height: 13 },
    detailHeader: { x: 343, y: 3, width: 118, height: 12 },
    list: { x: 9, y: 23, width: 192, height: 82 },
    detail: { x: 213, y: 23, width: 248, height: 93 },
    footerY: 122,
};

// Slot: single pane 5,2 248x118, with a metal button strip beneath it.
export const BAR_LAYOUT: MissionPanelLayout = {
    background: 'nova:8503',
    width: 263,
    height: 185,
    header: { x: 8, y: 4, width: 242, height: 14 },
    list: { x: 8, y: 22, width: 242, height: 94 },
    footerY: 126,
};

export interface VisiblePage {
    start: number;
    end: number;
}

export function preferRetailOffers<T>(
    retail: readonly T[],
    synthetic: readonly T[],
): readonly T[] {
    return retail.length > 0 ? retail : synthetic;
}

/**
 * Keep the selected variable-height row inside a fixed-height viewport.
 * Heights include each row's desired inter-row gap.
 */
export function selectionPage(
    heights: readonly number[],
    selected: number,
    previousStart: number,
    viewportHeight: number,
): VisiblePage {
    if (heights.length === 0 || selected < 0) {
        return { start: 0, end: 0 };
    }
    const clampedSelected = Math.min(selected, heights.length - 1);
    let start = Math.min(Math.max(0, previousStart), clampedSelected);

    const fits = (from: number, through: number) => {
        let used = 0;
        for (let index = from; index <= through; index++) {
            used += Math.min(heights[index] ?? 0, viewportHeight);
        }
        return used <= viewportHeight;
    };

    while (start < clampedSelected && !fits(start, clampedSelected)) {
        start++;
    }
    while (start > 0 && fits(start - 1, clampedSelected)) {
        start--;
    }

    let end = start;
    let used = 0;
    while (end < heights.length) {
        const height = Math.min(heights[end] ?? 0, viewportHeight);
        if (end > start && used + height > viewportHeight) {
            break;
        }
        used += height;
        end++;
    }
    return { start, end };
}
