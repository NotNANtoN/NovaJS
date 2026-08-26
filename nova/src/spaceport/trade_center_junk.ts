import { JunkData } from 'novadatainterface/JunkData';
import { sameResourceId } from '../common/resource_id';
import {
    evaluateTestExpression,
    NcbTestContext,
} from '../nova_plugin/ncb';

export interface JunkTradeOffer {
    commodity: string;
    cargoKey: string;
    price: number;
    canBuy: boolean;
    canSell: boolean;
    junkId: string;
}

/**
 * The Bible specifies only BasePrice for jünk: "The average price of the
 * commodity (works much like the base prices for 'regular' commodities)."
 * Unlike spöb's six regular-commodity nibbles, jünk has no price-level field.
 * The spöb list explicitly labels those nibbles, e.g. "0x10000000 Low food
 * prices" through "0x40000000 High food prices".
 */
export function junkPrice(junk: Pick<JunkData, 'basePrice'>): number {
    return junk.basePrice;
}

export function junkExpressionMatches(
    expression: string,
    context: NcbTestContext,
): boolean {
    try {
        return evaluateTestExpression(expression, context);
    } catch {
        return false;
    }
}

function includesStellar(
    stellars: readonly string[],
    planetId: string,
): boolean {
    return stellars.some(id => sameResourceId(id, planetId));
}

/** A listed jünk route makes the Trade Center a stellar service of its own. */
export function hasJunkTradeLocation(
    junkGoods: readonly JunkData[],
    planetId: string,
): boolean {
    return junkGoods.some(junk =>
        includesStellar(junk.soldAt, planetId)
        || includesStellar(junk.boughtAt, planetId));
}

/**
 * Build the special-cargo rows for one stellar.
 *
 * Bible: BuyOn means the jünk is "available to be bought" only while its
 * expression is true; SellOn means it is "able to be sold" only while true.
 * Those gates apply independently because retail goods are often one-way.
 */
export function junkTradeOffersAt(
    junkGoods: readonly JunkData[],
    planetId: string,
    context: NcbTestContext,
): JunkTradeOffer[] {
    return junkGoods.flatMap(junk => {
        const canBuy = includesStellar(junk.soldAt, planetId)
            && junkExpressionMatches(junk.buyOn, context);
        const canSell = includesStellar(junk.boughtAt, planetId)
            && junkExpressionMatches(junk.sellOn, context);
        return canBuy || canSell
            ? [{
                commodity: junk.name,
                // The Bible identifies LCName as the player-info cargo label.
                cargoKey: junk.lcName || junk.name,
                price: junkPrice(junk),
                canBuy,
                canSell,
                junkId: junk.id,
            }]
            : [];
    });
}
