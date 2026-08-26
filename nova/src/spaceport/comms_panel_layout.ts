/**
 * Geometry for the hail dialog.
 *
 * Retail's dialog item lists live in the Nova application's own resource fork,
 * not in the data files, so the panel is laid out against the PICT's borders:
 * one message pane inset from the frame, with the buttons on the footer strip
 * the artwork already provides.
 */

/** PICT 8508, a single message pane above a button footer, 387x219. */
export const COMMS_LAYOUT = {
    background: 'nova:8508',
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

/**
 * Space buttons evenly along the footer. Widths are given by the caller
 * because retail's labels differ wildly in length, and a fixed grid would
 * clip "Request Assistance".
 */
export function commsButtonSlots(
    widths: readonly number[],
    layout: { width: number, footerY: number } = COMMS_LAYOUT,
    margin = 10,
    gap = 8,
): CommsButtonSlot[] {
    const total = widths.reduce((sum, width) => sum + width, 0)
        + gap * Math.max(0, widths.length - 1);
    const available = layout.width - margin * 2;
    // Buttons that do not fit are squeezed proportionally rather than
    // overflowing the frame.
    const scale = total > available ? available / total : 1;
    // Buttons are positioned by their left edge, as elsewhere in the
    // spaceport dialogs.
    let x = -layout.width / 2 + margin;
    return widths.map(width => {
        const scaled = width * scale;
        const slot = { x, y: layout.footerY, width: scaled };
        x += scaled + gap * scale;
        return slot;
    });
}
