import 'jasmine';
import {
    tradeAccountText,
    tradeColumnHeadings,
    tradeEmptyText,
    TradeDisplayOffer,
    tradeOfferRows,
    tradeSelectionText,
} from './trade_center_content';

const offers: TradeDisplayOffer[] = [
    { commodity: 'Food', priceLevel: 'low', price: 60 },
    { commodity: 'Industrial Goods', priceLevel: 'medium', price: 350 },
    { commodity: 'Medical Supplies', priceLevel: 'high', price: 937 },
];

describe('Trade Center content', () => {
    it('builds independently aligned commodity, price, and hold columns', () => {
        const held = new Map([['Food', 4], ['Industrial Goods', 12]]);
        const rows = tradeOfferRows(
            offers, 1, commodity => held.get(commodity) ?? 0);

        expect(rows.commodities.split('\n')).toEqual([
            '  Food',
            '▶ Industrial Goods',
            '  Medical Supplies',
        ]);
        expect(rows.prices.split('\n')).toEqual(['60', '350', '937']);
        expect(rows.held.split('\n')).toEqual(['4', '12', '0']);
        expect(tradeColumnHeadings()).toEqual({
            commodities: 'Commodity',
            prices: 'Price',
            held: 'Hold',
        });
    });

    it('preserves retail per-commodity low, medium, and high prices', () => {
        expect(tradeSelectionText(offers[0])).toContain('Low price · 60');
        expect(tradeSelectionText(offers[1])).toContain('Medium price · 350');
        expect(tradeSelectionText(offers[2])).toContain('High price · 937');
    });

    it('shows only the requested visible page', () => {
        const page = tradeOfferRows(offers, 2, () => 0, 1, 3);
        expect(page.commodities).not.toContain('Food');
        expect(page.commodities).toContain('Industrial Goods');
        expect(page.commodities).toContain('▶ Medical Supplies');
    });

    it('shortens names that cannot fit the commodity column', () => {
        const rows = tradeOfferRows([{
            commodity: 'Ancient Vell-os Sculpture',
            priceLevel: 'low',
            price: 400,
        }], 0, () => 1);
        expect(rows.commodities).toBe('▶ Ancient Vell-os Sc…');
    });

    it('reports credits, used cargo, and free cargo', () => {
        expect(tradeAccountText({
            credits: 12345.9,
            cargoTons: 7,
            cargoCapacity: 20,
            transactionMessage: 'Bought 1t Food for 60 cr.',
        })).toBe([
            'Credits 12,345 cr',
            'Cargo 7/20 tons · 13 free',
            'Bought 1t Food for 60 cr.',
        ].join('\n'));
    });

    it('distinguishes an empty market from a missing pilot', () => {
        expect(tradeEmptyText(true)).toContain('no commodity exchange');
        expect(tradeEmptyText(false)).toContain('not available');
    });
});
