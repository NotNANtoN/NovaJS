import "jasmine";
import {
    clampScroll,
    heldScrollDistance,
    pictPopupVisibleLines,
    POPUP_LINE_HEIGHT,
    POPUP_MIDDLE_MAX,
    POPUP_MIDDLE_MIN,
    POPUP_SCROLL_HOLD_DELAY,
    POPUP_SCROLL_HOLD_SPEED,
    tiledPopupLayout,
    wrapMissionText,
} from './popup_layout.js';

describe('tiledPopupLayout', () => {
    // The four sigma popups, measured on the original-hardware captures:
    // lines of text -> the frame's total height (top 9 + middle + bottom 40).
    it('reproduces the reference frames line for line', () => {
        // 2_sigma_1_accept.png: 7 lines, frame y=465..615.
        expect(tiledPopupLayout(7).middleHeight).toBe(102);
        expect(tiledPopupLayout(7).totalHeight).toBe(151);
        // 4_sigma_1_return.png: 10 lines, frame y=447..633.
        expect(tiledPopupLayout(10).middleHeight).toBe(138);
        expect(tiledPopupLayout(10).totalHeight).toBe(187);
        // kiniké_kont_probe_..._accept.png: 11 lines, frame y=441..639.
        expect(tiledPopupLayout(11).totalHeight).toBe(199);
    });

    it('holds a four-line floor for short text', () => {
        // 3_sigma_1_pick_up_cargo.png: two lines in a 66px strip.
        expect(tiledPopupLayout(2).middleHeight).toBe(POPUP_MIDDLE_MIN);
        expect(tiledPopupLayout(1).middleHeight).toBe(POPUP_MIDDLE_MIN);
        expect(tiledPopupLayout(4).middleHeight).toBe(POPUP_MIDDLE_MIN);
        expect(tiledPopupLayout(2).maxScroll).toBe(0);
    });

    it('stops growing at the original ceiling and scrolls instead', () => {
        const capped = tiledPopupLayout(30);
        expect(capped.middleHeight).toBe(POPUP_MIDDLE_MAX);
        // The kont-probe offer shows 21 lines at the ceiling.
        expect(capped.visibleLines).toBe(21);
        expect(capped.windowHeight).toBe(21 * POPUP_LINE_HEIGHT);
        expect(capped.maxScroll).toBe(9 * POPUP_LINE_HEIGHT);
    });

    it('shows every line when the text fits', () => {
        for (const lines of [1, 3, 8, 15, 21]) {
            const layout = tiledPopupLayout(lines);
            expect(layout.visibleLines)
                .toBeGreaterThanOrEqual(Math.min(lines, 21));
            expect(layout.maxScroll).toBe(0);
        }
    });
});

describe('pictPopupVisibleLines', () => {
    it('fits sixteen lines in the desc+pict well', () => {
        // The well is 203px tall; 5_sigma_1_mission_text_with_pict.png's
        // twelve lines sit in it with room to spare.
        expect(pictPopupVisibleLines()).toBe(16);
    });
});

describe('scroll offsets', () => {
    it('clamps to the scrollable range', () => {
        expect(clampScroll(-5, 100)).toBe(0);
        expect(clampScroll(50, 100)).toBe(50);
        expect(clampScroll(150, 100)).toBe(100);
    });

    it('does not glide until the hold delay has passed', () => {
        expect(heldScrollDistance(0)).toBe(0);
        expect(heldScrollDistance(POPUP_SCROLL_HOLD_DELAY)).toBe(0);
    });

    it('glides at the hold speed afterwards', () => {
        const oneSecondPast = POPUP_SCROLL_HOLD_DELAY + 1000;
        expect(heldScrollDistance(oneSecondPast))
            .toBeCloseTo(POPUP_SCROLL_HOLD_SPEED, 6);
        // Twice as long past the delay travels twice as far.
        expect(heldScrollDistance(POPUP_SCROLL_HOLD_DELAY + 2000))
            .toBeCloseTo(POPUP_SCROLL_HOLD_SPEED * 2, 6);
    });
});

describe('wrapMissionText', () => {
    // A stand-in metric: every character is 1 wide, so a wrap width is a
    // character count and the expectations read as the original's do.
    const measure = (s: string) => s.length;

    it('greedily fills each line', () => {
        expect(wrapMissionText('aaa bbb ccc ddd', 7, measure))
            .toEqual(['aaa bbb', 'ccc ddd']);
    });

    it('keeps blank lines between paragraphs', () => {
        expect(wrapMissionText('one\n\ntwo', 10, measure))
            .toEqual(['one', '', 'two']);
    });

    it('lets trailing spaces hang past the wrap width', () => {
        // "aaa bbb" is exactly 7 wide; the double space after it must not
        // push "ccc" onto the line, nor count against the line's width.
        expect(wrapMissionText('aaa bbb  ccc', 7, measure))
            .toEqual(['aaa bbb', 'ccc']);
    });

    it('breaks after a hyphen inside a word', () => {
        // 4_sigma_1_return.png breaks "non-Sigma" after the hyphen.
        expect(wrapMissionText('all non-Sigma personnel', 9, measure))
            .toEqual(['all non-', 'Sigma', 'personnel']);
    });

    it('keeps a hyphenated word whole when it fits', () => {
        expect(wrapMissionText('all non-Sigma staff', 13, measure))
            .toEqual(['all non-Sigma', 'staff']);
    });

    it('leaves an over-long word on its own line', () => {
        expect(wrapMissionText('a supercalifragilistic b', 5, measure))
            .toEqual(['a', 'supercalifragilistic', 'b']);
    });

    it('drops the whitespace a line wrapped on', () => {
        for (const line of wrapMissionText('aaa bbb ccc', 3, measure)) {
            expect(line).toBe(line.trim());
        }
    });
});
