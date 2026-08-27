import 'jasmine';
import { createDraft, finishDraft } from 'immer';
import { plainSnapshot } from './draft_snapshot';

describe('plainSnapshot', () => {
    it('survives the draft it was taken from being finished', () => {
        // This is what ends a step: the draft a system read is revoked, and
        // anything that kept a reference to it throws on the next touch.
        const draft = createDraft({
            credits: 5_000,
            legalRecords: { 'nova:151': -40 },
        });
        const copy = plainSnapshot(draft);
        draft.credits = 4_000;
        finishDraft(draft);

        expect(() => draft.credits).toThrow();
        expect(copy.credits).toBe(5_000);
        expect(Object.keys(copy.legalRecords)).toEqual(['nova:151']);
    });

    it('passes plain values through untouched', () => {
        const value = { credits: 10 };
        expect(plainSnapshot(value)).toBe(value);
        expect(plainSnapshot(undefined)).toBeUndefined();
    });
});
