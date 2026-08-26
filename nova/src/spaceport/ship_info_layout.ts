/**
 * Geometry for the retail pilot-status frame, PICT 8507 (614x537).
 *
 * Measured slots: a large upper pane (x=4 y=2 603x404), a thin divider
 * strip (x=4 y=410 603x27), and a lower pane (x=5 y=440 603x94) whose
 * right half is covered by a metal block that carries the button.
 *
 * Coordinates are centered on the dialog, matching Menu containers.
 */
export const SHIP_INFO_FRAME = { width: 614, height: 537 } as const;

const CENTER_X = SHIP_INFO_FRAME.width / 2;
const CENTER_Y = SHIP_INFO_FRAME.height / 2;

function slot(x: number, y: number, width: number, height: number) {
    return { x: x - CENTER_X, y: y - CENTER_Y, width, height };
}

export const SHIP_INFO_LAYOUT = {
    background: 'nova:8507',
    /** Pilot and ship facts, top of the left column of the upper pane. */
    facts: slot(16, 12, 280, 206),
    /** Standing with each government, under the facts. */
    standing: slot(16, 222, 280, 174),
    /** Outfits, right column of the upper pane. */
    outfits: slot(310, 12, 292, 384),
    /** One-line cargo summary in the divider strip. */
    summary: slot(16, 415, 580, 18),
    /** Active missions, kept clear of the metal button block. */
    missions: slot(16, 448, 244, 80),
    /** Inside the metal block at the bottom right. */
    doneButton: { x: 120, y: 218 },
} as const;
