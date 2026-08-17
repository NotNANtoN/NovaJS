/**
 * Keyboard selection in the spaceport's row lists (mission BBS, the 'i'
 * active-missions list, the trade center, and any sibling that adopts the
 * same look). Up at the top wraps to the bottom and down at the bottom
 * wraps to the top, the way the original's lists do — a bare clamp left
 * the arrow keys dead at either end.
 */
export function wrapIndex(index: number, delta: number,
    length: number): number {
    if (length <= 0) {
        return 0;
    }
    return (((index + delta) % length) + length) % length;
}

/**
 * wrapIndex over a list where some rows are unselectable (the mission
 * board's section headers): steps by `delta` until a selectable row is
 * found, wrapping as it goes; returns `index` unchanged when nothing is
 * selectable.
 */
export function wrapToSelectable(index: number, delta: number,
    length: number, selectable: (i: number) => boolean): number {
    let next = index;
    for (let steps = 0; steps < length; steps++) {
        next = wrapIndex(next, delta, length);
        if (selectable(next)) {
            return next;
        }
    }
    return index;
}
