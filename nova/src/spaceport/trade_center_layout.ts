/**
 * Geometry for the retail Trade Center frame, PICT 8506 (250x285).
 *
 * The artwork contains a title slot at x=5 y=4 240x24 and a single market
 * pane at x=4 y=32 241x214. The metal strip below y=246 carries the buttons.
 * Unlike PICT 8500, this frame has no landscape slot for the list to cover.
 */
export const TRADE_CENTER_FRAME = {
    width: 250,
    height: 285,
} as const;

const CENTER_X = TRADE_CENTER_FRAME.width / 2;
const CENTER_Y = TRADE_CENTER_FRAME.height / 2;

export interface TradeRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

function centered(
    x: number,
    y: number,
    width: number,
    height: number,
): TradeRect {
    return {
        x: x - CENTER_X,
        y: y - CENTER_Y,
        width,
        height,
    };
}

/** Measured opaque-black slots in the PICT, exposed for geometry tests. */
export const TRADE_CENTER_SLOTS = {
    title: centered(5, 4, 240, 24),
    market: centered(4, 32, 241, 214),
    footer: centered(0, 246, 250, 39),
} as const;

export const TRADE_CENTER_LAYOUT = {
    background: 'nova:8506',
    title: centered(9, 7, 232, 18),
    commodityHeading: centered(10, 36, 124, 14),
    priceHeading: centered(136, 36, 65, 14),
    heldHeading: centered(203, 36, 36, 14),
    commodityList: centered(10, 52, 124, 84),
    priceList: centered(136, 52, 65, 84),
    heldList: centered(203, 52, 36, 84),
    detail: centered(10, 142, 229, 32),
    status: centered(10, 180, 229, 60),
    visibleRows: 7,
    footerY: 253 - CENTER_Y,
} as const;

export interface TradePage {
    start: number;
    end: number;
}

/** Keep the selected offer visible without scrolling an already-visible row. */
export function tradeSelectionPage(
    total: number,
    selected: number,
    previousStart: number,
    visibleRows = TRADE_CENTER_LAYOUT.visibleRows,
): TradePage {
    if (total <= 0 || selected < 0) {
        return { start: 0, end: 0 };
    }
    const rows = Math.max(1, Math.floor(visibleRows));
    const current = Math.min(Math.floor(selected), total - 1);
    const lastStart = Math.max(0, total - rows);
    let start = Math.min(Math.max(0, Math.floor(previousStart)), lastStart);
    if (current < start) {
        start = current;
    } else if (current >= start + rows) {
        start = current - rows + 1;
    }
    start = Math.min(start, lastStart);
    return { start, end: Math.min(total, start + rows) };
}

const BUTTON_CAP_WIDTH = 13;
const BUTTON_HEIGHT = 25;

export interface TradeButtonSlot {
    /** Left edge of the complete button, in dialog-centered coordinates. */
    x: number;
    y: number;
    /** Width of Button's tiled middle section. */
    width: number;
    /** Complete rendered width, including both 13px end caps. */
    visualWidth: number;
    visualHeight: number;
}

/**
 * Center a row of Button instances in the frame's metal footer. Button's
 * width argument excludes its two caps, so they must count toward fitting.
 */
export function tradeButtonSlots(
    widths: readonly number[],
    gap = 4,
): TradeButtonSlot[] {
    const visualWidths = widths.map(width =>
        Math.max(0, width) + BUTTON_CAP_WIDTH * 2);
    const total = visualWidths.reduce((sum, width) => sum + width, 0)
        + Math.max(0, widths.length - 1) * gap;
    let x = -total / 2;
    return widths.map((width, index) => {
        const visualWidth = visualWidths[index]!;
        const result = {
            x,
            y: TRADE_CENTER_LAYOUT.footerY,
            width: Math.max(0, width),
            visualWidth,
            visualHeight: BUTTON_HEIGHT,
        };
        x += visualWidth + gap;
        return result;
    });
}
