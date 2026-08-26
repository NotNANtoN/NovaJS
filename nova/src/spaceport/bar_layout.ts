/**
 * Measured geometry for retail PICT 8504, “Bar + pict” (266x306).
 *
 * The decoded retail pixels contain two pure-black connected components:
 * x=3 y=3 259x119 and x=11 y=128 242x113. The metal below y=242 is the
 * 266x64 button footer. Content is inset from each black component so glyph
 * antialiasing never touches the bevel.
 */
export const BAR_FRAME = {
    width: 266,
    height: 306,
} as const;

export interface BarRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

const CENTER_X = BAR_FRAME.width / 2;
const CENTER_Y = BAR_FRAME.height / 2;

function centered(
    x: number,
    y: number,
    width: number,
    height: number,
): BarRect {
    return {
        x: x - CENTER_X,
        y: y - CENTER_Y,
        width,
        height,
    };
}

/** Exact bounding boxes of the two pure-black artwork components. */
export const BAR_SLOTS = {
    text: centered(3, 3, 259, 119),
    picture: centered(11, 128, 242, 113),
    footer: centered(0, 242, 266, 64),
} as const;

export const BAR_LAYOUT = {
    background: 'nova:8504',
    text: centered(7, 7, 251, 111),
    picture: centered(15, 132, 234, 105),
    footerTop: 246 - CENTER_Y,
} as const;

const BUTTON_CAP_WIDTH = 13;
const BUTTON_HEIGHT = 25;

export interface BarButtonSlot {
    x: number;
    y: number;
    /** Width of Button's tiled middle section. */
    width: number;
    /** Complete rendered width, including both 13px end caps. */
    visualWidth: number;
    visualHeight: number;
}

/**
 * Fit complete retail buttons into one footer row.
 *
 * Button widths exclude their two end caps. If labels would overflow, only
 * their tiled middle sections shrink; the artwork caps remain undistorted.
 */
export function barButtonSlots(
    widths: readonly number[],
    margin = 4,
    gap = 2,
): BarButtonSlot[] {
    const available = BAR_FRAME.width - margin * 2
        - gap * Math.max(0, widths.length - 1);
    const capTotal = widths.length * BUTTON_CAP_WIDTH * 2;
    const middleTotal = widths.reduce(
        (sum, width) => sum + Math.max(0, width), 0);
    const scale = middleTotal > 0
        ? Math.min(1, Math.max(0, available - capTotal) / middleTotal)
        : 1;
    const visualWidths = widths.map(width =>
        Math.max(0, width) * scale + BUTTON_CAP_WIDTH * 2);
    const total = visualWidths.reduce((sum, width) => sum + width, 0)
        + gap * Math.max(0, widths.length - 1);
    let x = -total / 2;
    return widths.map((width, index) => {
        const middleWidth = Math.max(0, width) * scale;
        const visualWidth = visualWidths[index]!;
        const slot = {
            x,
            y: BAR_LAYOUT.footerTop,
            width: middleWidth,
            visualWidth,
            visualHeight: BUTTON_HEIGHT,
        };
        x += visualWidth + gap;
        return slot;
    });
}
