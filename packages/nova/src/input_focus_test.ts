import 'jasmine';
import { beginPixiTextEntry, isTextEntryActive } from './input_focus.js';

// These specs run in node (no DOM), so the document.activeElement branch is
// inert and isTextEntryActive reflects the PIXI text-entry count alone.
describe('input focus tracking', () => {
    it('is inactive by default', () => {
        expect(isTextEntryActive()).toBe(false);
    });

    it('is active while a PIXI text entry is registered', () => {
        const release = beginPixiTextEntry();
        expect(isTextEntryActive()).toBe(true);
        release();
        expect(isTextEntryActive()).toBe(false);
    });

    it('releasing twice does not go negative', () => {
        const release = beginPixiTextEntry();
        release();
        release();
        expect(isTextEntryActive()).toBe(false);
        // A later registration still works.
        const release2 = beginPixiTextEntry();
        expect(isTextEntryActive()).toBe(true);
        release2();
        expect(isTextEntryActive()).toBe(false);
    });

    it('supports nested text entries', () => {
        const outer = beginPixiTextEntry();
        const inner = beginPixiTextEntry();
        outer();
        expect(isTextEntryActive()).toBe(true);
        inner();
        expect(isTextEntryActive()).toBe(false);
    });
});
