import {
    cargoTons,
    PlayerState,
} from '../nova_plugin/player_state';

export type StatusBarCargoState = Pick<
    PlayerState,
    'credits' | 'cargoCapacity' | 'holds'
>;

export interface StatusBarCargoText {
    credits: string;
    cargo: string;
}

function formatNumber(value: number): string {
    return value.toLocaleString('en-US');
}

export function formatCredits(credits: number): string {
    return `${formatNumber(credits)} cr`;
}

export function formatCargo(used: number, capacity: number): string {
    return `${formatNumber(used)} / ${formatNumber(capacity)} tons`;
}

export function statusBarCargoText(
    state: StatusBarCargoState,
): StatusBarCargoText {
    return {
        credits: formatCredits(state.credits),
        cargo: formatCargo(cargoTons(state), state.cargoCapacity),
    };
}

export function statusBarTargetStatus(
    disabled: boolean,
): string | undefined {
    return disabled ? 'Disabled' : undefined;
}

/**
 * What a completed boarding took. A hull with nothing left to take is a real
 * outcome and has to read as one, or the pilot cannot tell it from a failure.
 */
export function boardingOutcomeText(cargo: number, credits: number): string {
    const taken: string[] = [];
    if (cargo > 0) {
        taken.push(`${formatNumber(cargo)} tons of cargo`);
    }
    if (credits > 0) {
        taken.push(formatCredits(credits));
    }
    return taken.length === 0
        ? 'Boarded: nothing worth taking.'
        : `Boarded: took ${taken.join(' and ')}.`;
}
