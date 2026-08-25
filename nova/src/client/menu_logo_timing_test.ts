import 'jasmine';
import {
    RETAIL_LOGO_FRAME_DURATION_MS,
    logoTickAt,
    nextLogoFrameDeadline,
    nextLogoFrame,
    shouldAdvanceLogoFrame,
} from './menu_logo_timing';

describe('retail menu logo timing', () => {
    it('samples the logo every third original 30 Hz tick', () => {
        expect(RETAIL_LOGO_FRAME_DURATION_MS).toBeCloseTo(100, 8);
        expect(logoTickAt(RETAIL_LOGO_FRAME_DURATION_MS - 0.01)).toBe(0);
        expect(logoTickAt(RETAIL_LOGO_FRAME_DURATION_MS)).toBe(1);
        expect(logoTickAt(RETAIL_LOGO_FRAME_DURATION_MS * 7.2)).toBe(7);
    });

    it('skips missed ticks after a render gap instead of replaying a burst', () => {
        const beforeGap = logoTickAt(40);
        const afterGap = logoTickAt(240);
        expect(afterGap - beforeGap).toBe(2);
        expect(afterGap).toBe(2);
        expect(shouldAdvanceLogoFrame(240, 40)).toBeTrue();
        expect(shouldAdvanceLogoFrame(250, 240)).toBeFalse();
        expect(nextLogoFrameDeadline(240, 66.67)).toBeCloseTo(
            240 + RETAIL_LOGO_FRAME_DURATION_MS,
            5,
        );
        expect(nextLogoFrameDeadline(70, 66.67)).toBeCloseTo(166.67, 1);
    });

    it('selects any random retail frame, including a valid repeat', () => {
        expect(nextLogoFrame(3, 0)).toBe(0);
        expect(nextLogoFrame(3, 0.5)).toBe(3);
        expect(nextLogoFrame(3, 0.999999)).toBe(6);
    });
});
