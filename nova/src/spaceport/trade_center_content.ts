import {
    CommodityPriceLevel,
} from 'novadatainterface/CommodityData';

export interface TradeDisplayOffer {
    commodity: string;
    priceLevel: CommodityPriceLevel;
    price: number;
}

export interface TradeColumnText {
    commodities: string;
    prices: string;
    held: string;
}

export interface TradeAccount {
    credits: number;
    cargoTons: number;
    cargoCapacity: number;
    transactionMessage?: string;
}

const PRICE_FORMAT = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
});

function formatNumber(value: number): string {
    return PRICE_FORMAT.format(Math.floor(value));
}

function displayCommodity(name: string, maxLength = 19): string {
    if (name.length <= maxLength) {
        return name;
    }
    return `${name.slice(0, maxLength - 1)}…`;
}

export function tradeColumnHeadings(): TradeColumnText {
    return {
        commodities: 'Commodity',
        prices: 'Price',
        held: 'Hold',
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
        prices: visible.map(offer => formatNumber(offer.price)).join('\n'),
        held: visible.map(offer =>
            formatNumber(Math.max(0, heldTons(offer.commodity)))).join('\n'),
    };
}

export function tradeSelectionText(
    offer: TradeDisplayOffer | undefined,
): string {
    if (!offer) {
        return '';
    }
    const priceLevel = offer.priceLevel[0]!.toUpperCase()
        + offer.priceLevel.slice(1);
    return [
        offer.commodity,
        `${priceLevel} price · ${formatNumber(offer.price)} cr per ton`,
    ].join('\n');
}

export function tradeAccountText(account: TradeAccount): string {
    const capacity = Math.max(0, Math.floor(account.cargoCapacity));
    const cargo = Math.max(0, Math.floor(account.cargoTons));
    const free = Math.max(0, capacity - cargo);
    const lines = [
        `Credits ${formatNumber(account.credits)} cr`,
        `Cargo ${cargo}/${capacity} tons · ${free} free`,
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
