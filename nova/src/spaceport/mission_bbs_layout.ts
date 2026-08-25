export interface MissionPanelLayout {
    background: string;
    width: number;
    height: number;
    header: { x: number; y: number; width: number; height: number };
    list: { x: number; y: number; width: number; height: number };
    detail?: { x: number; y: number; width: number; height: number };
    footerY: number;
}

export const MISSION_BBS_LAYOUT: MissionPanelLayout = {
    background: 'nova:8505',
    width: 510,
    height: 201,
    header: { x: 10, y: 4, width: 400, height: 15 },
    list: { x: 10, y: 30, width: 210, height: 144 },
    detail: { x: 229, y: 30, width: 275, height: 124 },
    footerY: 174,
};

export const MISSION_INFO_LAYOUT: MissionPanelLayout = {
    background: 'nova:8517',
    width: 471,
    height: 155,
    header: { x: 9, y: 4, width: 455, height: 15 },
    list: { x: 9, y: 24, width: 195, height: 95 },
    detail: { x: 214, y: 24, width: 250, height: 95 },
    footerY: 119,
};

export const BAR_LAYOUT: MissionPanelLayout = {
    background: 'nova:8503',
    width: 263,
    height: 185,
    header: { x: 9, y: 4, width: 243, height: 15 },
    list: { x: 9, y: 24, width: 243, height: 95 },
    footerY: 119,
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
