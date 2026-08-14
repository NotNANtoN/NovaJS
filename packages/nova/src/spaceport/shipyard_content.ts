/**
 * The text the shipyard's price pane shows, kept free of PIXI so it can
 * be unit-tested the way display/status_bar_content.ts is.
 *
 * The layout and wording come from the original, measured against
 * ui_screenshots/original_macos_screenshots/shipyard/earth_spaceport.png,
 * which shows the pane under the ship picture reading:
 *
 *     Ship Price:    10,000 cr
 *     Trade-In:      70,500 cr
 *
 *     Final Price:   0 cr
 *
 *     You Have:      546,553 cr
 *
 * (that shot is a Shuttle selected while flying something far more
 * valuable, which is why the trade-in dwarfs the price and the final
 * price is the clamped 0 of shipPurchasePrice's judgment call 4).
 *
 * Every number here is produced by the same shipyard_rules functions the
 * purchase itself charges through -- tradeInValue and shipPurchasePrice
 * -- so the quoted price can never drift from the amount debited. In
 * particular the exclusion of persistent (oütf 0x0004) outfits from the
 * trade-in is inherited rather than restated.
 */
import { ShipData } from 'novadatainterface/ship_data';
import { formatPrice } from './format_price.js';
import {
    ShipPurchaseContext,
    shipPurchasePrice,
    tradeInValue,
} from './shipyard_rules.js';

/** The four label/value rows of the shipyard's price pane. */
export interface ShipyardPriceReadout {
    /** The selected ship's list price (shïp Cost). */
    shipPrice: string;
    /** What the current ship and its non-persistent outfits are worth. */
    tradeIn: string;
    /** What the player is actually charged: price - trade-in, min 0. */
    finalPrice: string;
    /** The player's credits. */
    youHave: string;
}

/** The labels, in the original's wording and row order. */
export const SHIPYARD_PRICE_LABELS = {
    shipPrice: 'Ship Price:',
    tradeIn: 'Trade-In:',
    finalPrice: 'Final Price:',
    youHave: 'You Have:',
} as const;

/**
 * The price pane for `newShip` given the player's current state, or
 * undefined when there is nothing to price yet -- no selection, or the
 * current hull's ShipData still loading. The menu blanks the pane in
 * that case rather than quote a trade-in computed from an incomplete
 * valuation, which is the same reason canBuyShip is refused there.
 */
export function shipyardPriceReadout(newShip: ShipData | undefined,
    context: ShipPurchaseContext | undefined): ShipyardPriceReadout | undefined {
    if (!newShip || !context) {
        return undefined;
    }
    return {
        shipPrice: formatPrice(newShip.price),
        tradeIn: formatPrice(tradeInValue(context)),
        finalPrice: formatPrice(shipPurchasePrice(newShip, context)),
        youHave: formatPrice(context.credits),
    };
}
