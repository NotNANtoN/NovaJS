/**
 * Geometry for the hail dialog.
 *
 * Retail's dialog item lists live in the Nova application's own resource fork,
 * not in the data files, so the panel is laid out against the PICT's borders:
 * one message pane inset from the frame, with the buttons on the footer strip
 * the artwork already provides.
 */

export const COMMS_SHIP_BACKGROUND = 'nova:8511'; // Retail PICT 8511 "Communications"
export const COMMS_PLANET_BACKGROUND = 'nova:8512'; // Retail PICT 8512 "Planet Communications"
export const COMMS_ESCORT_BACKGROUND = 'nova:8513'; // Retail PICT 8513 "Escort communications"

/** Authentic retail communications dialog layout. */
export const COMMS_LAYOUT = {
    background: COMMS_SHIP_BACKGROUND,
    width: 387,
    height: 219,
    /** The dark pane, in coordinates relative to the panel's centre. */
    message: { x: -180, y: -86, width: 360, height: 130 },
    footerY: 74,
    buttonHeight: 20,
} as const;

export interface CommsButtonSlot {
    x: number;
    y: number;
    width: number;
}

const BUTTON_CAPS = 26;

/**
 * Space buttons evenly along the footer, accounting for each button's 26px caps.
 * Widths represent the inner text area passed to Button, and buttons are spaced
 * with consistent margins and gaps without overlapping.
 */
export function commsButtonSlots(
    widths: readonly number[],
    layout: { width: number, footerY: number } = COMMS_LAYOUT,
    margin = 12,
    gap = 8,
): CommsButtonSlot[] {
    const totalPhysical = widths.reduce((sum, width) => sum + width + BUTTON_CAPS, 0)
        + gap * Math.max(0, widths.length - 1);
    const available = layout.width - margin * 2;
    // Buttons that do not fit are squeezed proportionally rather than
    // overflowing the frame.
    const scale = totalPhysical > available ? available / totalPhysical : 1;
    let x = -totalPhysical * scale / 2;
    return widths.map(width => {
        const scaled = width * scale;
        const slot = { x, y: layout.footerY, width: scaled };
        x += (scaled + BUTTON_CAPS + gap) * scale;
        return slot;
    });
}
