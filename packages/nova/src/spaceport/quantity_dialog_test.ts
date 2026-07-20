import 'jasmine';
import { clampQuantity, editQuantityText } from './quantity_dialog.js';

describe('editQuantityText', () => {
    it('appends typed digits', () => {
        expect(editQuantityText('', '1')).toBe('1');
        expect(editQuantityText('1', '0')).toBe('10');
    });

    it('replaces a lone zero instead of making a leading zero', () => {
        expect(editQuantityText('0', '5')).toBe('5');
        expect(editQuantityText('0', '0')).toBe('0');
    });

    it('deletes with Backspace', () => {
        expect(editQuantityText('10', 'Backspace')).toBe('1');
        expect(editQuantityText('', 'Backspace')).toBe('');
    });

    it('ignores everything that is not a digit or Backspace', () => {
        // Letters must not edit the field: 'd' cancels, 'b'/'s' are
        // navigation keys elsewhere, and none of them belong in a
        // quantity.
        for (const key of ['d', 'b', 's', 'ArrowUp', ' ', '-', '.', 'e']) {
            expect(editQuantityText('12', key)).toBeUndefined();
        }
    });

    it('stops appending at the field capacity', () => {
        const full = '999999999';
        expect(editQuantityText(full, '1')).toBe(full);
    });
});

describe('clampQuantity', () => {
    it('parses the entered quantity', () => {
        expect(clampQuantity('8', 100)).toBe(8);
        expect(clampQuantity('42', 100)).toBe(42);
    });

    it('clamps over-entered quantities to the most allowed', () => {
        expect(clampQuantity('5000', 3977)).toBe(3977);
        expect(clampQuantity('999999999', 1)).toBe(1);
    });

    it('treats empty and zero entries as nothing', () => {
        expect(clampQuantity('', 100)).toBe(0);
        expect(clampQuantity('0', 100)).toBe(0);
    });

    it('never returns a negative quantity', () => {
        expect(clampQuantity('5', -3)).toBe(0);
    });
});
