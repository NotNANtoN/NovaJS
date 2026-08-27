import 'jasmine';
import {
    TRADE_COMMODITY_MAX_LENGTH,
} from './trade_center_content';
import {
    TRADE_CENTER_ROW_PITCH,
    TRADE_CENTER_FRAME,
    TRADE_CENTER_LAYOUT,
    TRADE_CENTER_SLOTS,
    TRADE_COMMODITY_COLUMN_WIDTH,
    TRADE_COMMODITY_GLYPH_GUTTER_WIDTH,
    TRADE_COMMODITY_TEXT_WIDTH,
    TradeRect,
    tradeButtonSlots,
    tradeRowY,
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
    it('uses the measured 8510 frame', () => {
        expect(TRADE_CENTER_LAYOUT.background).toBe('nova:8510');
        expect(TRADE_CENTER_FRAME).toEqual({ width: 426, height: 252 });
        expect(TRADE_CENTER_SLOTS.market).toEqual({
            x: -174, y: -117, width: 350, height: 175,
        });
        expect(TRADE_CENTER_SLOTS.account).toEqual({
            x: -174, y: 63, width: 350, height: 25,
        });
    });

    it('keeps every text element inside an opaque-black slot', () => {
        expectInside(TRADE_CENTER_LAYOUT.title, TRADE_CENTER_SLOTS.title);
        for (const region of [
            TRADE_CENTER_LAYOUT.commodityHeading,
            TRADE_CENTER_LAYOUT.heldHeading,
            TRADE_CENTER_LAYOUT.priceHeading,
            TRADE_CENTER_LAYOUT.commodityGlyphs,
            TRADE_CENTER_LAYOUT.commodityList,
            TRADE_CENTER_LAYOUT.heldList,
            TRADE_CENTER_LAYOUT.priceList,
            TRADE_CENTER_LAYOUT.detail,
            TRADE_CENTER_LAYOUT.status,
        ]) {
            expectInside(region, TRADE_CENTER_SLOTS.market);
        }
    });

    it('keeps the three table columns separate', () => {
        const layout = TRADE_CENTER_LAYOUT;
        expect(layout.commodityList.x + layout.commodityList.width)
            .toBeLessThanOrEqual(layout.heldList.x);
        expect(layout.heldList.x + layout.heldList.width)
            .toBeLessThanOrEqual(layout.priceList.x);
        expect(layout.priceList.x + layout.priceList.width)
            .toBeLessThanOrEqual(TRADE_CENTER_SLOTS.market.x
                + TRADE_CENTER_SLOTS.market.width);
        expect(layout.commodityGlyphs.x
            + layout.commodityGlyphs.width).toBe(layout.commodityList.x);
        expect(layout.commodityGlyphs.width)
            .toBe(TRADE_COMMODITY_GLYPH_GUTTER_WIDTH);
        expect(layout.commodityGlyphs.width + layout.commodityList.width)
            .toBe(TRADE_COMMODITY_COLUMN_WIDTH);
        expect(layout.commodityList.width).toBe(TRADE_COMMODITY_TEXT_WIDTH);
        expect(layout.heldList.width).toBe(48);
        expect(layout.priceList.width).toBe(52);
    });

    it('re-derives truncation for the glyph-reduced commodity width', () => {
        expect(TRADE_COMMODITY_GLYPH_GUTTER_WIDTH).toBe(12);
        expect(TRADE_COMMODITY_TEXT_WIDTH).toBe(208);
        expect(TRADE_COMMODITY_MAX_LENGTH).toBe(
            Math.floor(33 * TRADE_COMMODITY_TEXT_WIDTH
                / TRADE_COMMODITY_COLUMN_WIDTH));
    });

    it('aligns pooled rows with the joined-text line pitch', () => {
        for (let row = 0; row < TRADE_CENTER_LAYOUT.visibleRows; row++) {
            const commodityY = tradeRowY(
                TRADE_CENTER_LAYOUT.commodityList, row);
            expect(tradeRowY(TRADE_CENTER_LAYOUT.commodityGlyphs, row))
                .toBe(commodityY);
            expect(tradeRowY(TRADE_CENTER_LAYOUT.heldList, row))
                .toBe(commodityY);
            expect(tradeRowY(TRADE_CENTER_LAYOUT.priceList, row))
                .toBe(commodityY);
            expect(commodityY).toBe(
                TRADE_CENTER_LAYOUT.commodityList.y
                + row * TRADE_CENTER_ROW_PITCH);
        }
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
