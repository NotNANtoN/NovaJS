import 'jasmine';
import {
    tradeAccountText,
    tradeColumnHeadings,
    tradeEmptyText,
    TradeDisplayOffer,
    tradeOfferRows,
    tradePriceColor,
    tradePriceRows,
    TRADE_PRICE_COLORS,
    tradeSelectionText,
    TRADE_COMMODITY_MAX_LENGTH,
} from './trade_center_content';

const offers: TradeDisplayOffer[] = [
    { commodity: 'Food', priceLevel: 'low', price: 60 },
    { commodity: 'Industrial Goods', priceLevel: 'medium', price: 350 },
    { commodity: 'Medical Supplies', priceLevel: 'high', price: 937 },
];

describe('Trade Center content', () => {
    it('builds retail-ordered commodity, hold, and price columns', () => {
        const held = new Map([['Food', 4], ['Industrial Goods', 12]]);
        const rows = tradeOfferRows(
            offers, 1, commodity => held.get(commodity) ?? 0);

        expect(rows.commodities.split('\n')).toEqual([
            '  Food',
            '▶ Industrial Goods',
            '  Medical Supplies',
        ]);
        expect(rows.held.split('\n')).toEqual(['4', '12', '0']);
        expect(rows.prices.split('\n')).toEqual([
            'Low 60',
            'Med 350',
            'High 937',
        ]);
        expect(tradeColumnHeadings()).toEqual({
            commodities: 'Commodity',
            held: 'In Hold',
            prices: 'Price',
        });
    });

    it('preserves retail per-commodity low, medium, and high prices', () => {
        expect(tradeSelectionText(offers[0])).toContain('Low price · 60');
        expect(tradeSelectionText(offers[1])).toContain('Medium price · 350');
        expect(tradeSelectionText(offers[2])).toContain('High price · 937');
    });

    it('uses restrained colors only for price-level extremes', () => {
        expect(tradePriceColor('low')).toBe(TRADE_PRICE_COLORS.low);
        expect(tradePriceColor('medium')).toBe(TRADE_PRICE_COLORS.medium);
        expect(tradePriceColor('high')).toBe(TRADE_PRICE_COLORS.high);
        expect(tradePriceColor(undefined)).toBe(TRADE_PRICE_COLORS.neutral);
        expect(TRADE_PRICE_COLORS.low).toBe(0x8fae98);
        expect(TRADE_PRICE_COLORS.medium).toBe(0xffffff);
        expect(TRADE_PRICE_COLORS.high).toBe(0xb9a06a);
        expect(TRADE_PRICE_COLORS.neutral).toBe(0xffffff);
        expect(new Set([
            TRADE_PRICE_COLORS.low,
            TRADE_PRICE_COLORS.medium,
            TRADE_PRICE_COLORS.high,
        ]).size).toBe(3);
    });

    it('labels special cargo that this stellar only buys', () => {
        expect(tradeSelectionText({
            commodity: 'Vrenna Ice Lizard Pelts',
            price: 750,
            canBuy: false,
            canSell: true,
        })).toBe([
            'Vrenna Ice Lizard Pelts',
            'Special cargo · 750 cr per ton',
            'Sell only at this stellar',
        ].join('\n'));
    });

    it('does not invent a price level for special cargo', () => {
        const specialOffer = {
            commodity: 'Vrenna Ice Lizard Pelts',
            price: 750,
        };
        const rows = tradeOfferRows([specialOffer], 0, () => 0);
        const [priceRow] = tradePriceRows([specialOffer]);
        expect(rows.prices).toBe('750');
        expect(priceRow!.color).toBe(TRADE_PRICE_COLORS.neutral);
        expect(rows.prices).not.toContain('Low');
        expect(rows.prices).not.toContain('Med');
        expect(rows.prices).not.toContain('High');
    });

    it('shows only the requested visible page', () => {
        const page = tradeOfferRows(offers, 2, () => 0, 1, 3);
        expect(page.commodities).not.toContain('Food');
        expect(page.commodities).toContain('Industrial Goods');
        expect(page.commodities).toContain('▶ Medical Supplies');
    });

    it('uses the wider commodity column without cutting a word in half', () => {
        const rows = tradeOfferRows([{
            commodity: 'Ancient Vell-os Sculpture from Vrenna',
            priceLevel: 'low',
            price: 400,
        }], 0, () => 1);
        expect(TRADE_COMMODITY_MAX_LENGTH).toBe(31);
        expect(rows.commodities)
            .toBe('▶ Ancient Vell-os Sculpture…');
    });

    it('reports credits, free cargo, and a transaction message', () => {
        expect(tradeAccountText({
            credits: 12345.9,
            cargoTons: 7,
            cargoCapacity: 20,
            heldCommodityTons: 7,
            transactionMessage: 'Bought 1t Food for 60 cr.',
        })).toBe([
            'Credits 12,345 cr',
            'Free cargo space: 13 tons',
            'Bought 1t Food for 60 cr.',
        ].join('\n'));
    });

    it('shows other cargo only when mission cargo occupies the hold', () => {
        const withMissionCargo = tradeAccountText({
            credits: 500,
            cargoTons: 8,
            cargoCapacity: 20,
            heldCommodityTons: 7,
        });
        expect(withMissionCargo).toContain('Other cargo: mission cargo');
        expect(withMissionCargo).toContain('Free cargo space: 12 tons');

        const withoutMissionCargo = tradeAccountText({
            credits: 500,
            cargoTons: 8,
            cargoCapacity: 20,
            heldCommodityTons: 8,
        });
        expect(withoutMissionCargo)
            .not.toContain('Other cargo: mission cargo');
        expect(withoutMissionCargo).toContain('Free cargo space: 12 tons');
    });

    it('distinguishes an empty market from a missing pilot', () => {
        expect(tradeEmptyText(true)).toContain('no commodity exchange');
        expect(tradeEmptyText(false)).toContain('not available');
    });
});
