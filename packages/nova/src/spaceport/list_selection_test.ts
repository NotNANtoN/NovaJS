import 'jasmine';
import { wrapIndex, wrapToSelectable } from './list_selection.js';

describe('list selection wrap-around', () => {
    it('wraps up from the top to the bottom and down from the bottom to '
        + 'the top', () => {
        expect(wrapIndex(0, -1, 5)).toBe(4);
        expect(wrapIndex(4, 1, 5)).toBe(0);
        expect(wrapIndex(2, 1, 5)).toBe(3);
        expect(wrapIndex(0, -1, 1)).toBe(0);
        expect(wrapIndex(0, 1, 0)).toBe(0);
    });

    it('skips unselectable rows (mission-board headers) while wrapping', () => {
        // [header, a, b, header, c]
        const selectable = (i: number) => i !== 0 && i !== 3;
        expect(wrapToSelectable(1, -1, 5, selectable)).toBe(4);
        expect(wrapToSelectable(4, 1, 5, selectable)).toBe(1);
        expect(wrapToSelectable(2, 1, 5, selectable)).toBe(4);
        // Nothing selectable: stays put.
        expect(wrapToSelectable(2, 1, 5, () => false)).toBe(2);
    });
});
