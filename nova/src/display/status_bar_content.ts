import {
    getFreeSpace,
    PlayerState,
} from '../nova_plugin/player_state';
import { cargoHoldLabel } from '../spaceport/ship_info_content';

export type StatusBarCargoState = Pick<
    PlayerState,
    'credits' | 'cargoCapacity' | 'holds' | 'activeMissions'
>;

export interface StatusBarCargoText {
    free: string;
    special?: string;
    credits: string;
}

export interface StatusBarNavigationText {
    heading: 'Hyperspace';
    destination: string;
}

export interface StatusBarTargetHealth {
    label?: 'Shield:' | 'Armor:';
    percent?: string;
    status?: string;
}

function formatNumber(value: number): string {
    return value.toLocaleString('en-US');
}

export function formatCredits(credits: number): string {
    return formatNumber(credits);
}

export function formatCargo(used: number, capacity: number): string {
    return `${formatNumber(used)} / ${formatNumber(capacity)} tons`;
}

export function statusBarCargoText(
    state: StatusBarCargoState,
    cargoNames: readonly string[] = [],
): StatusBarCargoText {
    const special = state.holds
        .filter(hold => hold.isMissionCargo && hold.tons > 0)
        .map(hold => ({
            commodity: hold.commodity,
            label: cargoHoldLabel(hold, state.activeMissions, cargoNames),
        }))
        .sort((left, right) => left.label.localeCompare(right.label)
            || left.commodity.localeCompare(right.commodity))[0]?.label;
    return {
        free: formatNumber(getFreeSpace(state)),
        special,
        credits: formatCredits(state.credits),
    };
}

export function statusBarNavigationText(
    route: readonly string[],
    destinationName: string | undefined,
): StatusBarNavigationText | undefined {
    const destination = destinationName?.trim();
    return route[0] && destination
        ? { heading: 'Hyperspace', destination }
        : undefined;
}

export function statusBarTargetStatus(
    disabled: boolean,
): string | undefined {
    return disabled ? 'Disabled' : undefined;
}

export function statusBarTargetHealth(
    disabled: boolean,
    shield?: number,
    armor?: number,
): StatusBarTargetHealth {
    const status = statusBarTargetStatus(disabled);
    if (status) {
        return { status };
    }
    if (typeof shield === 'number' && shield > 0) {
        return { label: 'Shield:', percent: `${shield}%` };
    }
    if (typeof armor === 'number') {
        return { label: 'Armor:', percent: `${armor}%` };
    }
    return {};
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
        taken.push(`${formatCredits(credits)} cr`);
    }
    return taken.length === 0
        ? 'Boarded: nothing worth taking.'
        : `Boarded: took ${taken.join(' and ')}.`;
}
