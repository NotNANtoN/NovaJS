import { NcbOperation, NcbSetExecutionOptions } from './ncb';
import {
    activateRank,
    deactivateRank,
    destroyStellar,
    exploreSystem,
    PlayerState,
    regenerateStellar,
    releaseMissionCargo,
} from './player_state';
import { OutfitsState } from './outfit_plugin';
import { resourceId } from '../common/resource_id';

type Handler<T extends NcbOperation['type']> =
    (operation: Extract<NcbOperation, { type: T }>) => void;

export interface NcbHandlerContext {
    state: PlayerState;
    outfits?: OutfitsState;
    shipDefaults?: ReadonlyMap<string, OutfitsState>;
    onMoveToSystem?: (systemId: string, relative: boolean) => void;
    onChangeShip?: (
        systemId: string,
        includeDefaults: boolean,
        resetNonPersistent: boolean,
    ) => void;
    onStartMission?: (missionId: number) => void;
    onAbortMission?: (missionId: number) => void;
    onFailMission?: (missionId: number) => void;
    onPlaySound?: (soundId: number) => void;
    onLeaveStellar?: (messageId: number) => void;
    onRenameShip?: (namesId: number) => void;
    logger?: (message: string) => void;
}

function outfitKey(outfits: OutfitsState, id: number): string {
    if (outfits.has(String(id))) {
        return String(id);
    }
    return resourceId(id);
}

function cloneOutfits(outfits: OutfitsState): OutfitsState {
    return new Map([...outfits].map(([id, value]) =>
        [id, { count: value.count }] as const));
}

function defaultsFor(
    context: NcbHandlerContext,
    id: string,
): OutfitsState | undefined {
    return context.shipDefaults?.get(id)
        ?? context.shipDefaults?.get(id.replace(/^.*:/, ''));
}

function grantOutfit(
    context: NcbHandlerContext,
    id: number,
): void {
    if (!context.outfits) {
        context.logger?.(`Cannot grant outfit ${id}: player ship is unavailable`);
        return;
    }
    const key = outfitKey(context.outfits, id);
    const existing = context.outfits.get(key);
    context.outfits.set(key, { count: (existing?.count ?? 0) + 1 });
}

function removeOutfit(
    context: NcbHandlerContext,
    id: number,
): void {
    if (!context.outfits) {
        context.logger?.(`Cannot remove outfit ${id}: player ship is unavailable`);
        return;
    }
    const key = outfitKey(context.outfits, id);
    const existing = context.outfits.get(key);
    if (!existing) {
        return;
    }
    if (existing.count <= 1) {
        context.outfits.delete(key);
    } else {
        existing.count--;
    }
}

function changeShip(
    context: NcbHandlerContext,
    id: number,
    includeDefaults: boolean,
    resetNonPersistent = false,
): void {
    const shipId = resourceId(id);
    if (context.outfits) {
        const defaults = defaultsFor(context, shipId);
        if (resetNonPersistent) {
            context.outfits.clear();
        }
        if (includeDefaults && defaults) {
            for (const [outfitId, value] of defaults) {
                const current = context.outfits.get(outfitId);
                context.outfits.set(outfitId, {
                    count: (current?.count ?? 0) + value.count,
                });
            }
        }
    }
    context.state.shipId = shipId;
    context.onChangeShip?.(shipId, includeDefaults, resetNonPersistent);
}

function activeMissionId(
    id: number,
    context: NcbHandlerContext,
): string {
    const wanted = resourceId(id);
    return context.state.activeMissions.find(entry =>
        entry.missionId === wanted
        || entry.missionId.replace(/^.*:/, '') === String(id))
        ?.missionId ?? wanted;
}

const pendingMissionStarts = new WeakMap<PlayerState, number[]>();

function queueMissionStart(state: PlayerState, id: number) {
    const queued = pendingMissionStarts.get(state) ?? [];
    queued.push(id);
    pendingMissionStarts.set(state, queued);
}

/** Drain NCB `S` ids queued while a set expression ran on this pilot. */
export function takePendingMissionStarts(state: PlayerState): number[] {
    const queued = pendingMissionStarts.get(state) ?? [];
    pendingMissionStarts.delete(state);
    return queued;
}

/**
 * Build the game-side callbacks for NCB's non-bit operators. Keeping this
 * separate from the parser lets tests exercise the operations without
 * constructing an ECS world, while the runtime supplies movement/audio and
 * mission lifecycle callbacks where those are available.
 */
export function createNcbHandlers(
    context: NcbHandlerContext,
): NonNullable<NcbSetExecutionOptions['handlers']> {
    const handlers: NonNullable<NcbSetExecutionOptions['handlers']> = {
        grantOutfit: operation => grantOutfit(context, operation.id),
        removeOutfit: operation => removeOutfit(context, operation.id),
        changeShip: operation => changeShip(
            context,
            operation.id,
            operation.includeDefaults,
            operation.resetNonPersistent ?? false),
        moveToSystem: operation => {
            const systemId = resourceId(operation.id);
            context.state.currentSystem = systemId;
            context.onMoveToSystem?.(systemId, false);
        },
        moveToSystemRelative: operation => {
            const systemId = resourceId(operation.id);
            context.onMoveToSystem?.(systemId, true);
        },
        activateRank: operation => activateRank(context.state, operation.id),
        deactivateRank: operation => deactivateRank(context.state, operation.id),
        destroyStellar: operation => destroyStellar(context.state, operation.id),
        regenerateStellar: operation =>
            regenerateStellar(context.state, operation.id),
        exploreSystem: operation => exploreSystem(context.state, operation.id),
        startMission: operation => {
            context.onStartMission?.(operation.id);
            queueMissionStart(context.state, operation.id);
        },
        abortMission: operation => {
            context.onAbortMission?.(operation.id);
            if (!context.onAbortMission) {
                const id = activeMissionId(operation.id, context);
                releaseMissionCargo(context.state, id);
                context.state.activeMissions = context.state.activeMissions
                    .filter(entry => entry.missionId !== id);
            }
        },
        failMission: operation => {
            context.onFailMission?.(operation.id);
            if (!context.onFailMission) {
                const id = activeMissionId(operation.id, context);
                const entry = context.state.activeMissions.find(item =>
                    item.missionId === id);
                if (entry) {
                    entry.state = 'failed';
                    releaseMissionCargo(context.state, id);
                }
            }
        },
        playSound: operation => context.onPlaySound?.(operation.id),
        leaveStellar: operation => context.onLeaveStellar?.(operation.id),
        renameShip: operation => context.onRenameShip?.(operation.id),
    };
    return handlers;
}

export function copyOutfits(outfits: OutfitsState): OutfitsState {
    return cloneOutfits(outfits);
}
