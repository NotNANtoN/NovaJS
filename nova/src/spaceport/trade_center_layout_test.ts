import 'jasmine';
import {
    TRADE_CENTER_FRAME,
    TRADE_CENTER_LAYOUT,
    TRADE_CENTER_SLOTS,
    TradeRect,
    tradeButtonSlots,
    tradeSelectionPage,
} from './trade_center_layout';

function expectInside(region: TradeRect, slot: TradeRect) {
    expect(region.x).toBeGreaterThanOrEqual(slot.x);
    expect(region.y).toBeGreaterThanOrEqual(slot.y);
    expect(region.x + region.width)
        .toBeLessThanOrEqual(slot.x + slot.width);
    expect(region.y + region.height)
        .toBeLessThanOrEqual(slot.y + slot.height);
}

describe('retail Trade Center layout', () => {
    it('uses the measured 8506 frame', () => {
        expect(TRADE_CENTER_LAYOUT.background).toBe('nova:8506');
        expect(TRADE_CENTER_FRAME).toEqual({ width: 250, height: 285 });
        expect(TRADE_CENTER_SLOTS.title.width).toBe(240);
        expect(TRADE_CENTER_SLOTS.market.height).toBe(214);
    });

    it('keeps every text element inside an opaque-black slot', () => {
        expectInside(TRADE_CENTER_LAYOUT.title, TRADE_CENTER_SLOTS.title);
        for (const region of [
            TRADE_CENTER_LAYOUT.commodityHeading,
            TRADE_CENTER_LAYOUT.priceHeading,
            TRADE_CENTER_LAYOUT.heldHeading,
            TRADE_CENTER_LAYOUT.commodityList,
            TRADE_CENTER_LAYOUT.priceList,
            TRADE_CENTER_LAYOUT.heldList,
            TRADE_CENTER_LAYOUT.detail,
            TRADE_CENTER_LAYOUT.status,
        ]) {
            expectInside(region, TRADE_CENTER_SLOTS.market);
        }
    });

    it('keeps the three table columns separate', () => {
        const layout = TRADE_CENTER_LAYOUT;
        expect(layout.commodityList.x + layout.commodityList.width)
            .toBeLessThanOrEqual(layout.priceList.x);
        expect(layout.priceList.x + layout.priceList.width)
            .toBeLessThanOrEqual(layout.heldList.x);
    });

    it('fits the complete buttons, including caps, in the footer', () => {
        const buttons = tradeButtonSlots([48, 48, 38]);
        expect(buttons.length).toBe(3);
        for (const button of buttons) {
            expectInside({
                x: button.x,
                y: button.y,
                width: button.visualWidth,
                height: button.visualHeight,
            }, TRADE_CENTER_SLOTS.footer);
        }
        expect(buttons[0]!.x + buttons[0]!.visualWidth)
            .toBeLessThanOrEqual(buttons[1]!.x);
        expect(buttons[1]!.x + buttons[1]!.visualWidth)
            .toBeLessThanOrEqual(buttons[2]!.x);
    });

    it('scrolls only when the selection leaves the visible rows', () => {
        expect(tradeSelectionPage(10, 5, 0, 7))
            .toEqual({ start: 0, end: 7 });
        expect(tradeSelectionPage(10, 7, 0, 7))
            .toEqual({ start: 1, end: 8 });
        expect(tradeSelectionPage(10, 2, 3, 7))
            .toEqual({ start: 2, end: 9 });
        expect(tradeSelectionPage(0, -1, 0, 7))
            .toEqual({ start: 0, end: 0 });
    });
});
