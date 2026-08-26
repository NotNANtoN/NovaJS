import { ShipData } from 'novadatainterface/ShipData';
import { EscortHireTerms } from './escort_plugin';

/**
 * What it costs to hire and keep an escort.
 *
 * Retail's own numbers stop short here. The Bible describes the Hiring Price
 * and Pay shown in the escort dialog but gives no formula for either, and no
 * shïp field holds them. It does, however, price escorts elsewhere: of
 * EscSellValue it says that given a value at or below zero, "Nova will
 * default to 10% of the ship's original cost". That is the only authoritative
 * anchor for what an escort of a given hull is worth, so hiring one costs
 * that same tenth, and a day of its pay is a tenth again.
 *
 * These two fractions are therefore deliberate local policy, not a
 * reconstruction of retail arithmetic. They are here, in one place, so that
 * finding the real rule means changing two numbers.
 */
export const HIRE_PRICE_FRACTION = 0.1;
export const DAILY_PAY_FRACTION = 0.01;

/**
 * The Bible does not state a maximum either, only that the escort dialog
 * reports one. Four keeps a hired wing readable on the escort menu, which
 * retail organises into four categories.
 */
export const MAXIMUM_ESCORTS = 4;

export function hirePrice(ship: Pick<ShipData, 'cost'>): number {
    return Math.max(1, Math.floor(ship.cost * HIRE_PRICE_FRACTION));
}

export function dailyPay(ship: Pick<ShipData, 'cost'>): number {
    return Math.max(1, Math.floor(ship.cost * DAILY_PAY_FRACTION));
}

export function escortTerms(
    id: string,
    ship: Pick<ShipData, 'cost'>,
): EscortHireTerms {
    return {
        id,
        shipId: id,
        hirePrice: hirePrice(ship),
        dailyPay: dailyPay(ship),
    };
}
