import 'jasmine';
import {
    BAR_LAYOUT,
    MISSION_BBS_LAYOUT,
    MISSION_INFO_LAYOUT,
    preferRetailOffers,
    selectionPage,
} from './mission_bbs_layout';

describe('retail mission dialog layout', () => {
    it('uses the measured retail PICTs and content wells', () => {
        expect(MISSION_BBS_LAYOUT).toEqual(jasmine.objectContaining({
            background: 'nova:8505',
            width: 510,
            height: 201,
            list: { x: 10, y: 30, width: 210, height: 144 },
            detail: { x: 229, y: 30, width: 275, height: 124 },
        }));
        expect(MISSION_INFO_LAYOUT.background).toBe('nova:8517');
        expect(MISSION_INFO_LAYOUT.list).toEqual(
            { x: 9, y: 24, width: 195, height: 95 });
        expect(BAR_LAYOUT.background).toBe('nova:8503');
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
