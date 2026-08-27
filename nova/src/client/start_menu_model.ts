import type { GameDataInterface } from 'novadatainterface/GameDataInterface';
import type { GovtData } from 'novadatainterface/GovtData';
import type { PlayerState } from '../nova_plugin/player_state';
import { formatGameDate } from '../nova_plugin/player_state';
import {
    COMBAT_RATING_LADDER,
    LEGAL_STATUS_LADDER,
    combatRating,
    isCriminal,
    legalStatus,
    recordFor,
} from '../nova_plugin/legal_record';
import { resourceId } from '../common/resource_id';

export const RETAIL_MENU_ACTIONS = [
    'New Pilot',
    'Open Pilot',
    'Quit Nova',
    'Enter Ship',
    'Set Prefs',
    'About Nova',
] as const;

export type RetailMenuAction = typeof RETAIL_MENU_ACTIONS[number];

/**
 * rlëD 8020 is ordered like the six retail buttons. Its final frame is the
 * idle artwork containing the six narrow Nova marks seen in the retail menu.
 */
export const RETAIL_MENU_ROLLOVER_FRAMES:
Record<RetailMenuAction, number> = {
    'New Pilot': 0,
    'Open Pilot': 1,
    'Quit Nova': 2,
    'Enter Ship': 3,
    'Set Prefs': 4,
    'About Nova': 5,
};

export const RETAIL_MENU_IDLE_FRAME = 6;

export interface MenuRolloverState {
    hovered?: RetailMenuAction;
    focused?: RetailMenuAction;
}

export type MenuRolloverEvent = {
    type: 'pointer-enter' | 'pointer-leave' | 'focus' | 'blur';
    action: RetailMenuAction;
};

export function nextMenuRolloverState(
    state: MenuRolloverState,
    event: MenuRolloverEvent,
): MenuRolloverState {
    switch (event.type) {
        case 'pointer-enter':
            return { ...state, hovered: event.action };
        case 'pointer-leave':
            return state.hovered === event.action
                ? { ...state, hovered: undefined }
                : state;
        case 'focus':
            return { ...state, focused: event.action };
        case 'blur':
            return state.focused === event.action
                ? { ...state, focused: undefined }
                : state;
    }
}

export function menuRolloverFrame(state: MenuRolloverState): number {
    const action = state.focused ?? state.hovered;
    return action === undefined
        ? RETAIL_MENU_IDLE_FRAME
        : RETAIL_MENU_ROLLOVER_FRAMES[action];
}

export interface PilotStatField {
    label: string;
    value: string;
}

export interface PilotStatBlock {
    left: readonly PilotStatField[];
    right: readonly PilotStatField[];
    shipId: string;
    targetPict?: string;
}

function legalStatusFor(
    state: PlayerState,
    government: GovtData,
    governmentResourceId: string,
): string {
    // Match starmapPanelData: prefer an exact parsed government id, then use
    // recordFor so a missing save entry falls back to gövt/InitialRecord.
    const record = state.legalRecords?.[government.id] !== undefined
        ? state.legalRecords[government.id]!
        : recordFor(
            state.legalRecords,
            governmentResourceId,
            government,
        );
    const status = legalStatus(
        record,
        government.crimeTolerance ?? 0,
        LEGAL_STATUS_LADDER,
    );
    return isCriminal(record, government.crimeTolerance ?? 0)
        ? `${status} (hunted)`
        : status;
}

async function shipDetailsFor(
    state: PlayerState,
    gameData: GameDataInterface | undefined,
): Promise<{ shipClass: string; targetPict?: string }> {
    if (!gameData) {
        return { shipClass: 'Unknown' };
    }
    try {
        const ids = await gameData.ids;
        if (!ids.Ship.includes(state.shipId)) {
            return { shipClass: 'Unknown' };
        }
        const ship = await gameData.data.Ship.get(state.shipId);
        return {
            shipClass: ship.name || 'Unknown',
            targetPict: ship.targetPict,
        };
    } catch {
        return { shipClass: 'Unknown' };
    }
}

async function currentLegalStatusFor(
    state: PlayerState,
    gameData: GameDataInterface | undefined,
): Promise<string> {
    if (!gameData) {
        return LEGAL_STATUS_LADDER[0];
    }
    try {
        const system = await gameData.data.System.get(state.currentSystem);
        if (system.government === undefined || system.government < 0) {
            return LEGAL_STATUS_LADDER[0];
        }
        const governments = gameData.data.Govt;
        if (!governments) {
            return LEGAL_STATUS_LADDER[0];
        }
        const governmentResourceId = resourceId(system.government);
        const government = await governments.get(governmentResourceId);
        return legalStatusFor(state, government, governmentResourceId);
    } catch {
        return LEGAL_STATUS_LADDER[0];
    }
}

/**
 * Assemble the accessible DOM menu's fields without coupling the data lookup
 * to its layout. No selected pilot means no labels or placeholder values.
 */
export async function buildPilotStatBlock(
    state: PlayerState | undefined,
    gameData: GameDataInterface | undefined,
): Promise<PilotStatBlock | undefined> {
    if (!state) {
        return undefined;
    }
    const [shipDetails, currentLegalStatus] = await Promise.all([
        shipDetailsFor(state, gameData),
        currentLegalStatusFor(state, gameData),
    ]);
    return {
        shipId: state.shipId,
        targetPict: shipDetails.targetPict,
        left: [
            { label: 'Pilot Name', value: state.pilotName },
            { label: 'Ship Name', value: state.shipName },
            { label: 'Ship Class', value: shipDetails.shipClass },
        ],
        right: [
            {
                label: 'Legal status in current system',
                value: currentLegalStatus,
            },
            {
                label: 'Combat Rating',
                value: combatRating(
                    state.kills ?? 0,
                    COMBAT_RATING_LADDER,
                ),
            },
            { label: 'Current Date', value: formatGameDate(state.gameDate) },
        ],
    };
}

/**
 * Validate the targeting PICT before the DOM renderer receives its URL. The
 * request is deliberately separate from stat assembly so text never waits for
 * an optional image.
 */
export async function requestPilotTargetPicture(
    stats: PilotStatBlock | undefined,
    gameData: GameDataInterface | undefined,
): Promise<string | undefined> {
    const targetPict = stats?.targetPict;
    const images = gameData?.data.PictImage;
    if (!targetPict || !images) {
        return undefined;
    }
    try {
        await images.get(targetPict);
        return targetPict;
    } catch {
        return undefined;
    }
}

export class PilotTargetPictureCache<T> {
    private readonly loads = new Map<string, Promise<T | undefined>>();

    get(
        stats: PilotStatBlock,
        load: (stats: PilotStatBlock) => Promise<T | undefined>,
    ): Promise<T | undefined> {
        const cached = this.loads.get(stats.shipId);
        if (cached) {
            return cached;
        }
        const request = load(stats);
        this.loads.set(stats.shipId, request);
        return request;
    }
}
