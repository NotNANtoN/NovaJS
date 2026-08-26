import 'jasmine';
import {
    BAR_FRAME,
    BAR_LAYOUT,
    BAR_SLOTS,
    BarRect,
    barButtonSlots,
} from './bar_layout';

function expectInside(region: BarRect, slot: BarRect) {
    expect(region.x).toBeGreaterThanOrEqual(slot.x);
    expect(region.y).toBeGreaterThanOrEqual(slot.y);
    expect(region.x + region.width)
        .toBeLessThanOrEqual(slot.x + slot.width);
    expect(region.y + region.height)
        .toBeLessThanOrEqual(slot.y + slot.height);
}

describe('retail Bar + pict layout', () => {
    it('uses the decoded 8504 frame and measured black components', () => {
        expect(BAR_LAYOUT.background).toBe('nova:8504');
        expect(BAR_FRAME).toEqual({ width: 266, height: 306 });
        expect(BAR_SLOTS.text).toEqual({
            x: -130,
            y: -150,
            width: 259,
            height: 119,
        });
        expect(BAR_SLOTS.picture).toEqual({
            x: -122,
            y: -25,
            width: 242,
            height: 113,
        });
    });

    it('keeps text and pictures clear of the bevels', () => {
        expectInside(BAR_LAYOUT.text, BAR_SLOTS.text);
        expectInside(BAR_LAYOUT.picture, BAR_SLOTS.picture);
    });

    it('fits complete buttons, including caps, in the measured footer', () => {
        const buttons = barButtonSlots([45, 48, 75, 35]);
        for (const button of buttons) {
            expectInside({
                x: button.x,
                y: button.y,
                width: button.visualWidth,
                height: button.visualHeight,
            }, BAR_SLOTS.footer);
        }
        for (let index = 1; index < buttons.length; index++) {
            const previous = buttons[index - 1]!;
            expect(previous.x + previous.visualWidth)
                .toBeLessThanOrEqual(buttons[index]!.x);
        }
    });

    it('shrinks long middle tiles without distorting button caps', () => {
        const buttons = barButtonSlots([100, 100, 100, 100]);
        expect(buttons.every(button => button.width < 100)).toBeTrue();
        expect(buttons[0]!.visualWidth)
            .toBeGreaterThanOrEqual(26);
        const last = buttons[buttons.length - 1]!;
        expect(last.x + last.visualWidth)
            .toBeLessThanOrEqual(BAR_SLOTS.footer.x
                + BAR_SLOTS.footer.width);
    });
});
