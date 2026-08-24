import { TradeCommodity } from 'novadatainterface/CommodityData';
import {
    allocateCargo,
    getFreeSpace,
    PlayerState,
    releaseCargo,
} from './player_state';

export interface TradeTransaction {
    success: boolean;
    tons: number;
    total: number;
    reason?: string;
}

function transactionFailure(reason: string): TradeTransaction {
    return { success: false, tons: 0, total: 0, reason };
}

function validTons(tons: number): number {
    return Number.isFinite(tons) ? Math.floor(tons) : 0;
}

/**
 * Buy generic cargo at the price shown for the current stellar. One click in
 * the screen buys one ton, while tests and future quantity controls can pass
 * a larger amount.
 */
export function buyCommodity(
    state: PlayerState,
    offer: TradeCommodity,
    tons = 1,
): TradeTransaction {
    const quantity = validTons(tons);
    if (quantity <= 0) {
        return transactionFailure('Invalid quantity');
    }
    const total = offer.price * quantity;
    if (state.credits < total) {
        return transactionFailure('Not enough credits');
    }
    if (getFreeSpace(state) < quantity) {
        return transactionFailure('Not enough cargo space');
    }
    if (!allocateCargo(state, {
        commodity: offer.commodity,
        tons: quantity,
        isMissionCargo: false,
    })) {
        return transactionFailure('Cargo allocation failed');
    }
    state.credits -= total;
    return { success: true, tons: quantity, total };
}

/**
 * Sell only ordinary cargo. Mission reservations are deliberately never
 * eligible, even when their display text happens to match a commodity.
 */
export function sellCommodity(
    state: PlayerState,
    offer: TradeCommodity,
    tons = 1,
): TradeTransaction {
    const quantity = validTons(tons);
    if (quantity <= 0) {
        return transactionFailure('Invalid quantity');
    }
    const held = state.holds
        .filter(hold => hold.commodity === offer.commodity
            && !hold.isMissionCargo)
        .reduce((total, hold) => total + hold.tons, 0);
    if (held < quantity) {
        return transactionFailure('You do not hold that commodity');
    }
    const released = releaseCargo(
        state, offer.commodity, quantity, false);
    if (released !== quantity) {
        return transactionFailure('Cargo sale failed');
    }
    const total = offer.price * quantity;
    state.credits += total;
    return { success: true, tons: quantity, total };
}

export function heldCommodityTons(
    state: PlayerState,
    commodity: string,
): number {
    return state.holds
        .filter(hold => hold.commodity === commodity && !hold.isMissionCargo)
        .reduce((total, hold) => total + hold.tons, 0);
}

