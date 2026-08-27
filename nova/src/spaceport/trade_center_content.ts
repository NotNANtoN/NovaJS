import {
    CommodityPriceLevel,
} from 'novadatainterface/CommodityData';
import {
    TRADE_COMMODITY_COLUMN_WIDTH,
    TRADE_COMMODITY_TEXT_WIDTH,
} from './trade_center_layout';

export interface TradeDisplayOffer {
    commodity: string;
    cargoKey?: string;
    priceLevel?: CommodityPriceLevel;
    price: number;
    canBuy?: boolean;
    canSell?: boolean;
}

export interface TradeColumnText {
    commodities: string;
    held: string;
    prices: string;
}

export interface TradePriceRow {
    text: string;
    color: number;
}

export interface TradeAccount {
    credits: number;
    cargoTons: number;
    cargoCapacity: number;
    /** Ordinary cargo only; mission cargo is the difference from cargoTons. */
    heldCommodityTons?: number;
    transactionMessage?: string;
}

const PRICE_FORMAT = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
});

const PRICE_LEVEL_LABELS: Record<CommodityPriceLevel, string> = {
    low: 'Low',
    medium: 'Med',
    high: 'High',
};

export const TRADE_PRICE_COLORS = {
    low: 0x8fae98,
    medium: 0xffffff,
    high: 0xb9a06a,
    neutral: 0xffffff,
} as const;

const ORIGINAL_COMMODITY_MAX_LENGTH = 33;

/** Scale the old 220px character budget to the glyph-reduced text region. */
export const TRADE_COMMODITY_MAX_LENGTH = Math.floor(
    ORIGINAL_COMMODITY_MAX_LENGTH
    * TRADE_COMMODITY_TEXT_WIDTH
    / TRADE_COMMODITY_COLUMN_WIDTH,
);

function formatNumber(value: number): string {
    return PRICE_FORMAT.format(Math.floor(value));
}

function displayCommodity(
    name: string,
    maxLength = TRADE_COMMODITY_MAX_LENGTH,
): string {
    if (name.length <= maxLength) {
        return name;
    }
    const prefix = name.slice(0, maxLength - 1);
    const wordBoundary = prefix.lastIndexOf(' ');
    return `${prefix.slice(0, wordBoundary > 0 ? wordBoundary : prefix.length)}…`;
}

function formatPriceCell(offer: TradeDisplayOffer): string {
    const price = formatNumber(offer.price);
    return offer.priceLevel
        ? `${PRICE_LEVEL_LABELS[offer.priceLevel]} ${price}`
        : price;
}

export function tradePriceColor(
    level: CommodityPriceLevel | undefined,
): number {
    return level ? TRADE_PRICE_COLORS[level] : TRADE_PRICE_COLORS.neutral;
}

export function tradePriceRows(
    offers: readonly TradeDisplayOffer[],
    start = 0,
    end = offers.length,
): TradePriceRow[] {
    return offers.slice(
        Math.max(0, start),
        Math.max(Math.max(0, start), end),
    ).map(offer => ({
        text: formatPriceCell(offer),
        color: tradePriceColor(offer.priceLevel),
    }));
}

export function tradeColumnHeadings(): TradeColumnText {
    return {
        commodities: 'Commodity',
        held: 'In Hold',
        prices: 'Price',
    };
}

/** Build three synchronized text columns so proportional fonts still align. */
export function tradeOfferRows(
    offers: readonly TradeDisplayOffer[],
    selected: number,
    heldTons: (commodity: string) => number,
    start = 0,
    end = offers.length,
): TradeColumnText {
    const visible = offers.slice(
        Math.max(0, start),
        Math.max(Math.max(0, start), end),
    );
    return {
        commodities: visible.map((offer, index) => {
            const absoluteIndex = Math.max(0, start) + index;
            const marker = absoluteIndex === selected ? '▶ ' : '  ';
            return `${marker}${displayCommodity(offer.commodity)}`;
        }).join('\n'),
        held: visible.map(offer =>
            formatNumber(Math.max(
                0, heldTons(offer.cargoKey ?? offer.commodity)))).join('\n'),
        prices: tradePriceRows(visible).map(row => row.text).join('\n'),
    };
}

export function tradeSelectionText(
    offer: TradeDisplayOffer | undefined,
): string {
    if (!offer) {
        return '';
    }
    const price = offer.priceLevel
        ? `${offer.priceLevel[0]!.toUpperCase()
            + offer.priceLevel.slice(1)} price`
        : 'Special cargo';
    const canBuy = offer.canBuy !== false;
    const canSell = offer.canSell !== false;
    const availability = canBuy && canSell
        ? undefined
        : canBuy
            ? 'Buy only at this stellar'
            : 'Sell only at this stellar';
    return [
        offer.commodity,
        `${price} · ${formatNumber(offer.price)} cr per ton`,
        availability,
    ].filter((line): line is string => line !== undefined).join('\n');
}

export function tradeAccountText(account: TradeAccount): string {
    const capacity = Math.max(0, Math.floor(account.cargoCapacity));
    const cargo = Math.max(0, Math.floor(account.cargoTons));
    const free = Math.max(0, capacity - cargo);
    const held = Math.max(
        0,
        Math.floor(account.heldCommodityTons ?? cargo),
    );
    const lines = [
        `Credits ${formatNumber(account.credits)} cr`,
        ...(cargo > held ? ['Other cargo: mission cargo'] : []),
        `Free cargo space: ${free} tons`,
    ];
    if (account.transactionMessage) {
        lines.push(account.transactionMessage);
    }
    return lines.join('\n');
}

export function tradeEmptyText(hasPlayer: boolean): string {
    return hasPlayer
        ? 'This stellar has no commodity exchange.'
        : 'Pilot cargo information is not available.';
}
