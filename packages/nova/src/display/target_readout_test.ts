import 'jasmine';
import { targetReadout } from './target_readout.js';

describe('targetReadout (status bar target pane rule)', () => {
    it("a disabled target reads 'Disabled', hiding the percent even " +
        'when shield/armor values exist', () => {
            expect(targetReadout(true, 50, 80)).toEqual({ kind: 'disabled' });
            expect(targetReadout(true, 0, 10)).toEqual({ kind: 'disabled' });
            expect(targetReadout(true)).toEqual({ kind: 'disabled' });
        });

    it('shows shield percent while any shield remains', () => {
        expect(targetReadout(false, 73, 100))
            .toEqual({ kind: 'shield', percent: 73 });
    });

    it('falls back to armor percent once shields are gone', () => {
        expect(targetReadout(false, 0, 42))
            .toEqual({ kind: 'armor', percent: 42 });
        expect(targetReadout(false, undefined, 42))
            .toEqual({ kind: 'armor', percent: 42 });
    });

    it('shows nothing without stats', () => {
        expect(targetReadout(false)).toEqual({ kind: 'none' });
    });
});
