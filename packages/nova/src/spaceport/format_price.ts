/**
 * Credit formatting for the spaceport's price readouts, shared by the
 * outfitter and the shipyard so the two panes cannot drift apart. Kept
 * free of PIXI so the content functions that use it stay unit-testable.
 *
 * Lifted verbatim out of outfitter.ts (its only home until the shipyard
 * grew a price pane); behaviour is unchanged.
 */

function addCommas(p: number) {
    return p.toLocaleString();
}

/**
 * A credit amount as the spaceport panes print it: "10,000 cr" below a
 * million, and "1.500M cr" at or above it (three digits of millions
 * fraction, zero-padded).
 */
export function formatPrice(p: number) {
    var mil = 1000000;
    if (p >= mil) {
        var modmil = String(p % mil).substring(0, 3);
        modmil += "0".repeat(3 - modmil.length);
        return addCommas(Math.floor(p / mil)) + "." + modmil + "M cr";
    }
    else {
        return addCommas(p) + " cr";
    }
};
