import {
    getTradeCommodities,
    priceForLevel,
    COMMODITY_DEFINITIONS,
} from './CommodityData';

describe('generic commodity prices', () => {
    it('uses the retail low, medium, and high price list', () => {
        expect(COMMODITY_DEFINITIONS.map(definition => [
            priceForLevel(definition, 'low'),
            priceForLevel(definition, 'medium'),
            priceForLevel(definition, 'high'),
        ])).toEqual([
            [60, 75, 93],
            [280, 350, 437],
            [600, 750, 937],
            [720, 900, 1125],
            [160, 200, 250],
            [440, 550, 687],
        ]);
    });

    it('decodes the spöb market and ignores non-market stellars', () => {
        expect(getTradeCommodities(0x00000002
            | 0x10000000 | 0x04000000)).toEqual([
            {
                commodity: 'Food',
                priceLevel: 'low',
                price: 60,
            },
            {
                commodity: 'Industrial Goods',
                priceLevel: 'high',
                price: 437,
            },
        ]);
        expect(getTradeCommodities(0x10000000)).toEqual([]);
    });
});

