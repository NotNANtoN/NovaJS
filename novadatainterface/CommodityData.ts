/**
 * The six generic commodities shipped by the EV Nova engine.
 *
 * The names intentionally use the title case shown by the original trade
 * center. Mission cargo uses a mission id as its hold key, so it cannot be
 * accidentally bought or sold as a generic commodity.
 */
export const STANDARD_COMMODITIES = [
    'Food',
    'Industrial Goods',
    'Medical Supplies',
    'Luxury Goods',
    'Metal',
    'Equipment',
] as const;

export type StandardCommodity = typeof STANDARD_COMMODITIES[number];

export type CommodityPriceLevel = 'low' | 'medium' | 'high';

export interface TradeCommodity {
    commodity: StandardCommodity;
    priceLevel: CommodityPriceLevel;
    price: number;
}

export interface CommodityDefinition {
    commodity: StandardCommodity;
    basePrice: number;
    lowFlag: number;
    mediumFlag: number;
    highFlag: number;
}

/**
 * Bible, spöb resource: the low/medium/high flag for each commodity occupies
 * one nibble. The generic base prices are the values in STR# 9300-9305 in
 * the retail data; low and high are 80% and 125% respectively.
 */
export const COMMODITY_DEFINITIONS: readonly CommodityDefinition[] = [
    {
        commodity: 'Food',
        basePrice: 75,
        lowFlag: 0x10000000,
        mediumFlag: 0x20000000,
        highFlag: 0x40000000,
    },
    {
        commodity: 'Industrial Goods',
        basePrice: 350,
        lowFlag: 0x01000000,
        mediumFlag: 0x02000000,
        highFlag: 0x04000000,
    },
    {
        commodity: 'Medical Supplies',
        basePrice: 750,
        lowFlag: 0x00100000,
        mediumFlag: 0x00200000,
        highFlag: 0x00400000,
    },
    {
        commodity: 'Luxury Goods',
        basePrice: 900,
        lowFlag: 0x00010000,
        mediumFlag: 0x00020000,
        highFlag: 0x00040000,
    },
    {
        commodity: 'Metal',
        basePrice: 200,
        lowFlag: 0x00001000,
        mediumFlag: 0x00002000,
        highFlag: 0x00004000,
    },
    {
        commodity: 'Equipment',
        basePrice: 550,
        lowFlag: 0x00000100,
        mediumFlag: 0x00000200,
        highFlag: 0x00000400,
    },
];

export function priceForLevel(
    definition: CommodityDefinition,
    priceLevel: CommodityPriceLevel,
): number {
    if (priceLevel === 'low') {
        return Math.floor(definition.basePrice * 0.8);
    }
    if (priceLevel === 'high') {
        return Math.floor(definition.basePrice * 1.25);
    }
    return definition.basePrice;
}

/**
 * Decode the raw spöb flags into the market displayed by a stellar. A market
 * bit (0x00000002) is kept separate from the individual price nibbles in the
 * Bible, so a stellar without that bit has no trade center.
 */
export function getTradeCommodities(flags: number): TradeCommodity[] {
    if ((flags & 0x00000002) === 0) {
        return [];
    }

    return COMMODITY_DEFINITIONS.flatMap(definition => {
        const priceLevel = (flags & definition.lowFlag) !== 0
            ? 'low'
            : (flags & definition.mediumFlag) !== 0
                ? 'medium'
                : (flags & definition.highFlag) !== 0
                    ? 'high'
                    : undefined;
        return priceLevel === undefined
            ? []
            : [{
                commodity: definition.commodity,
                priceLevel,
                price: priceForLevel(definition, priceLevel),
            }];
    });
}

