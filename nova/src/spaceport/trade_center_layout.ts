/**
 * Geometry for the retail Trade Center frame, PICT 8510 (426x252).
 *
 * The artwork has an upper black pane at x=39 y=9 350x175, a short lower
 * black strip at x=39 y=189 350x25, and a metal button footer beginning at
 * y=214. Coordinates exposed below are centered on the PIXI background.
 */
export const TRADE_CENTER_FRAME = {
    width: 426,
    height: 252,
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
    title: centered(39, 9, 350, 175),
    market: centered(39, 9, 350, 175),
    account: centered(39, 189, 350, 25),
    footer: centered(0, 214, 426, 38),
} as const;

export const TRADE_COMMODITY_COLUMN_WIDTH = 220;
export const TRADE_COMMODITY_GLYPH_GUTTER_WIDTH = 12;
export const TRADE_COMMODITY_TEXT_WIDTH =
    TRADE_COMMODITY_COLUMN_WIDTH - TRADE_COMMODITY_GLYPH_GUTTER_WIDTH;
export const TRADE_CENTER_ROW_PITCH = 12;

export const TRADE_CENTER_LAYOUT = {
    background: 'nova:8510',
    title: centered(45, 10, 338, 14),
    commodityHeading: centered(
        45, 26, TRADE_COMMODITY_COLUMN_WIDTH, TRADE_CENTER_ROW_PITCH),
    heldHeading: centered(276, 26, 48, 12),
    priceHeading: centered(331, 26, 52, 12),
    commodityGlyphs: centered(
        45, 40, TRADE_COMMODITY_GLYPH_GUTTER_WIDTH, 60),
    commodityList: centered(
        45 + TRADE_COMMODITY_GLYPH_GUTTER_WIDTH,
        40,
        TRADE_COMMODITY_TEXT_WIDTH,
        60,
    ),
    heldList: centered(276, 40, 48, 60),
    priceList: centered(331, 40, 52, 60),
    detail: centered(45, 104, 338, 32),
    status: centered(45, 138, 338, 46),
    visibleRows: 5,
    footerY: 221 - CENTER_Y,
} as const;

/** Match the y coordinates produced by Geneva's 12px joined-line layout. */
export function tradeRowY(region: Pick<TradeRect, 'y'>, row: number): number {
    return region.y + Math.max(0, Math.floor(row)) * TRADE_CENTER_ROW_PITCH;
}

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
