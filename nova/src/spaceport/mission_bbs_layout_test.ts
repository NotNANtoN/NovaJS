import 'jasmine';
import {
    barOfferView,
    BAR_LAYOUT,
    fitLinesToHeight,
    MISSION_BBS_LAYOUT,
    MISSION_INFO_LAYOUT,
    preferRetailOffers,
    selectionPage,
} from './mission_bbs_layout';

describe('retail mission dialog layout', () => {
    // The opaque black slots in each retail PICT, measured from the
    // artwork. Every text region must sit inside one of them, or the text
    // spills onto the surrounding metal.
    type Rect = { x: number; y: number; width: number; height: number };
    const expectInside = (region: Rect | undefined, slot: Rect) => {
        expect(region).toBeDefined();
        expect(region!.x).toBeGreaterThanOrEqual(slot.x);
        expect(region!.y).toBeGreaterThanOrEqual(slot.y);
        expect(region!.x + region!.width)
            .toBeLessThanOrEqual(slot.x + slot.width);
        expect(region!.y + region!.height)
            .toBeLessThanOrEqual(slot.y + slot.height);
    };

    it('keeps every mission computer region inside a retail slot', () => {
        expect(MISSION_BBS_LAYOUT.background).toBe('nova:8505');
        expect(MISSION_BBS_LAYOUT.width).toBe(510);
        expect(MISSION_BBS_LAYOUT.height).toBe(201);
        expectInside(MISSION_BBS_LAYOUT.header,
            { x: 10, y: 2, width: 400, height: 17 });
        expectInside(MISSION_BBS_LAYOUT.list,
            { x: 6, y: 26, width: 214, height: 148 });
        expectInside(MISSION_BBS_LAYOUT.detailHeader,
            { x: 225, y: 26, width: 279, height: 29 });
        expectInside(MISSION_BBS_LAYOUT.detail,
            { x: 225, y: 57, width: 279, height: 97 });
    });

    it('uses both title slots of the mission info frame', () => {
        expect(MISSION_INFO_LAYOUT.background).toBe('nova:8517');
        expectInside(MISSION_INFO_LAYOUT.header,
            { x: 7, y: 2, width: 197, height: 13 });
        expectInside(MISSION_INFO_LAYOUT.detailHeader,
            { x: 340, y: 3, width: 124, height: 12 });
        expectInside(MISSION_INFO_LAYOUT.list,
            { x: 6, y: 20, width: 198, height: 88 });
        expectInside(MISSION_INFO_LAYOUT.detail,
            { x: 210, y: 20, width: 254, height: 99 });
    });

    it('treats the bar frame as one pane with no list column', () => {
        expect(BAR_LAYOUT.background).toBe('nova:8503');
        expect(BAR_LAYOUT.detail).toBeUndefined();
        expectInside(BAR_LAYOUT.header,
            { x: 5, y: 2, width: 248, height: 118 });
        expectInside(BAR_LAYOUT.list,
            { x: 5, y: 2, width: 248, height: 118 });
    });

    it('follows first, middle, and last variable-height selections', () => {
        const heights = [18, 32, 16, 44, 20, 28, 36];
        expect(selectionPage(heights, 0, 0, 70)).toEqual({
            start: 0,
            end: 3,
        });
        const middle = selectionPage(heights, 3, 0, 70);
        expect(middle.start).toBeLessThanOrEqual(3);
        expect(middle.end).toBeGreaterThan(3);
        const last = selectionPage(heights, 6, middle.start, 70);
        expect(last.start).toBeLessThanOrEqual(6);
        expect(last.end).toBe(7);
    });

    it('always exposes an oversized selected row by itself', () => {
        expect(selectionPage([20, 200, 20], 1, 0, 70))
            .toEqual({ start: 1, end: 2 });
    });

    it('does not append synthetic duplicates to retail offers', () => {
        expect(preferRetailOffers(['retail'], ['synthetic']))
            .toEqual(['retail']);
        expect(preferRetailOffers([], ['synthetic']))
            .toEqual(['synthetic']);
    });
});

describe('bar offer view', () => {
    const offer = { name: 'A Quiet Word', text: 'Deliver this crate.' };

    it('says nothing is on offer when the bar is empty', () => {
        expect(barOfferView(undefined, 0, 0))
            .toBe('Nobody here has work for you.');
    });

    it('shows one offer in full rather than a truncated list', () => {
        const view = barOfferView(offer, 0, 1);
        expect(view).toContain('A Quiet Word');
        expect(view).toContain('Deliver this crate.');
        // With a single offer there is nothing to browse.
        expect(view).not.toContain('of 1');
    });

    it('says how to reach the other offers', () => {
        const view = barOfferView(offer, 1, 3);
        expect(view).toContain('2 of 3');
        expect(view).toContain('up/down');
    });
});

describe('fitLinesToHeight', () => {
    it('keeps text that fits', () => {
        expect(fitLinesToHeight('one\ntwo', [10, 10], 40)).toBe('one\ntwo');
    });

    it('marks where longer text was cut', () => {
        const fitted = fitLinesToHeight(
            'one\ntwo\nthree\nfour', [10, 10, 10, 10], 25);
        expect(fitted).toBe('one\ntwo\n...');
    });

    it('always keeps at least the first line', () => {
        expect(fitLinesToHeight('only', [40], 10)).toBe('only\n...');
    });
});
