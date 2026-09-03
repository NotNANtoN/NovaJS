import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { MissionData } from 'novadatainterface/MissionData';
import { Optional } from 'nova_ecs/optional';
import { Emit, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { AsyncSystem } from 'nova_ecs/async_system';
import { v4 as uuid } from 'uuid';
import { resourceId } from '../common/resource_id';
import { PlayerShipSelector } from './player_ship_plugin';
import { InitiateJumpEvent } from './jump_plugin';
import { SoundEvent } from './sound_event';
import { GameDataResource } from './game_data_resource';
import {
    executeSetOperations,
    parseSetExpression,
} from './ncb';
import {
    createNcbHandlers,
    NcbHandlerContext,
    takePendingMissionStarts,
} from './ncb_handlers';
import {
    ActiveMission,
    advanceGameDate,
    allocateCargo,
    createMissionGoalProgress,
    getFreeSpace,
    MAX_ACTIVE_MISSIONS,
    MissionCargo,
    PlayerState,
    PlayerStateComponent,
    releaseMissionCargo,
    formatGameDate,
} from './player_state';
import {
    NcbRuntime,
    NcbRuntimeResource,
    PendingMissionJumpComponent,
    PendingMissionSoundComponent,
} from './ncb_runtime';
export {
    NcbRuntime,
    NcbRuntimeResource,
    PendingMissionJumpComponent,
    PendingMissionSoundComponent,
} from './ncb_runtime';
import { advanceMissionGoal, MissionGoalEvent } from './mission_goals';
import {
    formatMissionText,
    MissionTextValues,
} from './mission_text';
export { formatMissionText } from './mission_text';
export type { MissionTextValues } from './mission_text';
import {
    MissionPlanetSelector,
} from './mission_availability';
import {
    GovernmentRelation,
    resolveStellarSelector,
    resolveSystemSelector,
    StellarSelectorContext,
} from './stellar_selector';

export interface MissionNotice {
    missionId: string;
    kind: 'success' | 'failure';
    text: string;
}

export interface MissionDestinationOptions {
    initialPlanetId: string;
    planets?: readonly MissionPlanetSelector[];
    systems?: readonly {
        id: string;
        links?: readonly string[];
        planets?: readonly string[];
        government?: number;
    }[];
    governments?: readonly GovernmentRelation[];
    initialSystemId?: string;
    currentSystemId?: string;
    random?: () => number;
    resolved?: ResolvedMissionDestinations;
    ncb?: MissionSetContext;
}

export interface ResolvedMissionDestinations {
    travelDestination: string | '*';
    returnDestination: string | '*';
    shipSystem?: string;
}

export type MissionSetContext = Omit<NcbHandlerContext, 'state'>;

const MissionJumpSystem = new System({
    name: 'MissionJump',
    args: [
        PlayerShipSelector, PendingMissionJumpComponent, UUID, GetEntity, Emit,
    ] as const,
    step(_playerShip, pending, uuid, entity, emit) {
        emit(InitiateJumpEvent, { to: pending.systemId }, [uuid]);
        entity.components.delete(PendingMissionJumpComponent);
    },
});

const MissionSoundSystem = new System({
    name: 'MissionSound',
    args: [PlayerShipSelector, PendingMissionSoundComponent, UUID,
        GetEntity, Emit] as const,
    step(_playerShip, pending, _uuid, entity, emit) {
        emit(SoundEvent, { id: pending.soundId });
        entity.components.delete(PendingMissionSoundComponent);
    },
});

function runMissionSetExpression(
    expression: string | undefined,
    state: PlayerState,
    logger: (message: string) => void = console.warn,
    context: MissionSetContext = {},
) {
    if (!expression?.trim()) {
        return;
    }

    try {
        const operations = parseSetExpression(expression, { logger });
        const handlers = createNcbHandlers({ ...context, state, logger });
        // Bit operations are deliberately handled by ncb. All other
        // operations now dispatch to the game handlers above.
        executeSetOperations(operations, state.missionBits, {
            handlers,
            logger,
        });
    } catch (error) {
        logger(`Could not execute mission set expression '${expression}': ${error}`);
    }
}

function missionSelectorContext(
    state: PlayerState,
    options: MissionDestinationOptions,
): StellarSelectorContext {
    return {
        planets: options.planets,
        systems: options.systems,
        governments: options.governments,
        initialPlanetId: options.initialPlanetId,
        initialSystemId: options.initialSystemId ?? state.currentSystem,
        currentSystemId: options.currentSystemId ?? state.currentSystem,
        random: options.random,
    };
}

function concreteStellarDestination(
    selector: number,
    resolution: ReturnType<typeof resolveStellarSelector>,
    options: MissionDestinationOptions,
): string | '*' | undefined {
    if (resolution.wildcard) {
        return '*';
    }
    if (resolution.selected) {
        return resolution.selected;
    }
    // A fixed resource ID remains meaningful when a caller has not loaded a
    // galaxy catalog. With a catalog, an absent fixed resource is invalid.
    if (options.planets === undefined
        && selector >= 128 && selector <= 2175) {
        return resourceId(selector);
    }
    return undefined;
}

/**
 * Resolve every mission selector once at offer/accept time. The concrete
 * values are written to ActiveMission so random destinations never change
 * when a pilot is reloaded or the mission board is rendered again.
 */
export function resolveMissionDestinations(
    state: PlayerState,
    mission: MissionData,
    options: MissionDestinationOptions,
): ResolvedMissionDestinations | undefined {
    const baseContext = missionSelectorContext(state, options);
    const travelResolution = resolveStellarSelector(
        mission.travelStel, baseContext, 'destination');
    const travelDestination = concreteStellarDestination(
        mission.travelStel, travelResolution, options);
    if (travelDestination === undefined) {
        return undefined;
    }

    const returnResolution = resolveStellarSelector(
        mission.returnStel,
        {
            ...baseContext,
            travelPlanetId: travelDestination === '*' ? undefined : travelDestination,
        },
        'destination');
    const returnDestination = concreteStellarDestination(
        mission.returnStel, returnResolution, options);
    if (returnDestination === undefined) {
        return undefined;
    }

    let shipSystem: string | undefined;
    if (mission.shipCount >= 0 || mission.shipSyst !== -1) {
        // EV Nova Bible, mïsn/ShipSyst -6: "Whatever system the player is in
        // (i.e. follow him around)." Unlike random/fixed selectors, this one
        // must remain dynamic after acceptance.
        if (mission.shipSyst === -6) {
            shipSystem = '*';
        }
        const systemResolution = resolveSystemSelector(mission.shipSyst, {
            ...baseContext,
            travelPlanetId: travelDestination === '*' ? undefined : travelDestination,
            returnPlanetId: returnDestination === '*' ? undefined : returnDestination,
        });
        shipSystem ??= systemResolution.selected;
        if (!shipSystem && options.systems === undefined
            && mission.shipSyst >= 128 && mission.shipSyst <= 2175) {
            shipSystem = resourceId(mission.shipSyst);
        }
        if (!shipSystem) {
            return undefined;
        }
    }

    return { travelDestination, returnDestination, shipSystem };
}

function missionCargo(
    mission: MissionData,
    pickupDestination: string | '*' | undefined,
): MissionCargo | undefined {
    if (mission.cargoType < 0 || mission.cargoQty === -1) {
        return undefined;
    }

    // CargoQty <= -2 means an approximate quantity in EV Nova. The phase-one
    // inventory model has no tonnage component, so retain the nominal amount.
    return {
        type: mission.cargoType,
        quantity: Math.abs(mission.cargoQty),
        ...(pickupDestination === undefined
            ? {}
            : { pickupDestination }),
    };
}

function pickupAtTravel(mission: MissionData): boolean {
    return mission.pickupMode > 0;
}

function missionHoldsCargo(state: PlayerState, missionId: string): boolean {
    return state.holds.some(hold =>
        hold.isMissionCargo && hold.commodity === missionId);
}

function applyMissionCompletionRewards(
    state: PlayerState,
    mission: MissionData,
) {
    if (mission.payVal > 0) {
        state.credits += mission.payVal;
    } else if (mission.payVal < -1) {
        console.warn(`Mission pay value ${mission.payVal} is not implemented`);
    }
    if (mission.datePostInc > 0) {
        advanceGameDate(state, mission.datePostInc);
    }
    if (mission.compGovt >= 128 && mission.compReward !== 0) {
        const governmentId = resourceId(mission.compGovt);
        const records = { ...state.legalRecords };
        records[governmentId] = (records[governmentId] ?? 0) + mission.compReward;
        state.legalRecords = records;
    }
}

const MAX_NCB_MISSION_STARTS = 16;

function alreadyActive(state: PlayerState, missionId: string): boolean {
    return state.activeMissions.some(entry =>
        entry.state === 'active'
        && (entry.missionId === missionId
            || entry.missionId.replace(/^.*:/, '')
                === missionId.replace(/^.*:/, '')));
}

/**
 * Start missions queued by NCB `S` while a set expression ran.
 *
 * Story OnSuccess strings auto-start the next mïsn even when it is not on
 * the current BBS page. `S` still no-ops for boarding missions, full logs,
 * and destinations that cannot be resolved.
 */
export async function startPendingNcbMissions(
    gameData: GameDataInterface,
    state: PlayerState,
    options: MissionDestinationOptions = { initialPlanetId: '' },
): Promise<void> {
    const seen = new Set<string>();
    let queued = takePendingMissionStarts(state);
    let guard = 0;
    while (queued.length > 0 && guard < MAX_NCB_MISSION_STARTS) {
        guard += 1;
        for (const id of queued) {
            const missionId = resourceId(id);
            if (seen.has(missionId) || alreadyActive(state, missionId)) {
                continue;
            }
            seen.add(missionId);
            let mission: MissionData | undefined;
            try {
                mission = await gameData.data.Mission?.get(missionId);
            } catch (error) {
                console.warn(`NCB S${id}: could not load mission`, error);
                continue;
            }
            if (!mission) {
                continue;
            }
            acceptMission(state, mission, {
                ...options,
                initialPlanetId: options.initialPlanetId
                    || state.lastLandedPlanet,
                initialSystemId: options.initialSystemId
                    ?? state.currentSystem,
                currentSystemId: options.currentSystemId
                    ?? state.currentSystem,
            });
        }
        queued = takePendingMissionStarts(state);
    }
}

/**
 * Add a mission to PlayerState after running its OnAccept expression.
 *
 * Mission cargo is physical cargo: accepting a mission reserves its tons in
 * the hold, and completion/failure/abort releases that reservation.
 */
export function acceptMission(
    state: PlayerState,
    mission: MissionData,
    options: MissionDestinationOptions & {
        logger?: (message: string) => void;
    } = { initialPlanetId: '' },
): ActiveMission | undefined {

    if (state.activeMissions.filter(entry => entry.state === 'active').length
        >= MAX_ACTIVE_MISSIONS) {
        console.warn(`Cannot accept mission ${mission.id}: mission limit reached`);
        return undefined;
    }

    const resolved = options.resolved ?? resolveMissionDestinations(
        state, mission, options);
    if (!resolved) {
        console.warn(`Cannot accept mission ${mission.id}: destination cannot be resolved`);
        return undefined;
    }
    const pickupDestination = resolved.travelDestination;
    // DropOffMode 0 unloads at TravelStel. Completing only at ReturnStel
    // made passenger ferries ignore the planet named in the offer.
    const destination = mission.returnStel === -1 || mission.dropOffMode === 0
        ? resolved.travelDestination
        : resolved.returnDestination;

    const cargo = missionCargo(mission, pickupDestination);
    const loadOnAccept = cargo && !pickupAtTravel(mission);
    if (loadOnAccept && getFreeSpace(state) < cargo.quantity) {
        console.warn(`Cannot accept mission ${mission.id}: not enough cargo space`);
        return undefined;
    }
    if (loadOnAccept && !allocateCargo(state, {
        commodity: mission.id,
        tons: cargo.quantity,
        isMissionCargo: true,
    })) {
        console.warn(`Cannot accept mission ${mission.id}: cargo allocation failed`);
        return undefined;
    }
    runMissionSetExpression(
        mission.onAccept, state, options.logger, options.ncb);
    const missionUuid = uuid();
    const activeMission: ActiveMission = {
        missionId: mission.id,
        missionUuid,
        state: 'active',
        destination,
        travelDestination: resolved.travelDestination,
        returnDestination: resolved.returnDestination,
        acceptedDate: state.gameDate,
        ...(resolved.shipSystem === undefined
            ? {}
            : { shipSystem: resolved.shipSystem }),
        ...(cargo ? { cargo } : {}),
        ...(mission.id.startsWith('proc:')
            ? { missionData: mission }
            : {}),
        ...(mission.shipCount > 0 && mission.shipGoal >= 0
            ? {
                shipGoalProgress: createMissionGoalProgress(
                    mission.shipGoal, mission.shipCount),
            }
            : {}),
    };
    state.activeMissions.push(activeMission);
    return activeMission;
}

export function refuseMission(
    state: PlayerState,
    mission: MissionData,
    logger?: (message: string) => void,
    context: MissionSetContext = {},
) {
    runMissionSetExpression(mission.onRefuse, state, logger, context);
}

export function abortMission(
    state: PlayerState,
    entry: ActiveMission,
    mission: MissionData,
    logger?: (message: string) => void,
    context: MissionSetContext = {},
): boolean {
    if (!mission.canAbort || entry.state !== 'active') {
        return false;
    }
    runMissionSetExpression(mission.onAbort, state, logger, context);
    releaseMissionCargo(state, entry.missionId);
    const index = state.activeMissions.indexOf(entry);
    if (index >= 0) {
        state.activeMissions.splice(index, 1);
        return true;
    }
    return false;
}

function destinationMatches(destination: string | undefined, planetId: string) {
    if (destination === '*') {
        return true;
    }
    if (!destination) {
        return false;
    }
    return destination === planetId
        || destination.replace(/^.*:/, '') === planetId.replace(/^.*:/, '');
}

function missionEntryKey(entry: ActiveMission): string {
    return `${entry.missionId}:${entry.acceptedDate ?? 'legacy'}`;
}

/**
 * Whether this landing pays out the mission.
 *
 * Passenger/cargo drop-offs complete at TravelStel (the planet the log
 * shows). Other missions must land at ReturnStel after visiting TravelStel
 * when those planets differ.
 */
function landingCompletesMission(
    entry: ActiveMission,
    mission: MissionData,
    planetId: string,
): boolean {
    const travel = missionTravelDestination(entry);
    const atTravel = destinationMatches(travel, planetId);
    const atCompletion = destinationMatches(entry.destination, planetId);
    if (mission.dropOffMode === 0) {
        return atTravel || atCompletion;
    }
    if (!atCompletion) {
        return false;
    }
    const travelRequired = Boolean(travel)
        && travel !== '*'
        && mission.travelStel !== -1
        && (!entry.destination || !destinationMatches(travel, entry.destination));
    return !travelRequired || entry.travelVisited === true || atTravel;
}

function isExpired(state: PlayerState, entry: ActiveMission, mission: MissionData) {
    return mission.timeLimit > 0
        && entry.acceptedDate !== undefined
        && state.gameDate > entry.acceptedDate + mission.timeLimit;
}

function missionDeadline(state: PlayerState, entry: ActiveMission, mission: MissionData) {
    return mission.timeLimit > 0 && entry.acceptedDate !== undefined
        ? entry.acceptedDate + mission.timeLimit
        : undefined;
}

function missionGoalProgress(
    entry: ActiveMission,
    mission: MissionData,
) {
    if (mission.shipCount <= 0 || mission.shipGoal < 0) {
        return undefined;
    }
    if (!entry.shipGoalProgress) {
        entry.shipGoalProgress = createMissionGoalProgress(
            mission.shipGoal, mission.shipCount);
    }
    return entry.shipGoalProgress;
}

function activeMissionUuid(entry: ActiveMission): string {
    return entry.missionUuid
        ?? `${entry.missionId}:${entry.acceptedDate ?? 0}`;
}

function missionTravelDestination(entry: ActiveMission): string | undefined {
    return entry.travelDestination === '*' && entry.destination !== '*'
        ? entry.destination
        : entry.travelDestination ?? entry.destination;
}

function missionTextValues(
    state: PlayerState,
    entry: ActiveMission,
    mission: MissionData,
    destinationName: string,
    returnDestinationName = destinationName,
): MissionTextValues {
    const deadline = missionDeadline(state, entry, mission);
    return {
        destination: destinationName,
        returnDestination: returnDestinationName,
        cargo: mission.cargo ?? undefined,
        quantity: entry.cargo?.quantity,
        deadline: deadline === undefined ? undefined : formatGameDate(deadline),
        pay: mission.payVal > 0 ? mission.payVal : undefined,
        pilotName: state.pilotName,
        shipName: state.shipName,
        shipType: state.shipId,
        gender: state.gender,
        missionBits: state.missionBits,
        activeRanks: state.activeRanks,
    };
}

export class MissionRuntime {
    private missionCache = new Map<string, Promise<MissionData | undefined>>();
    private entryWork = new Map<string, Promise<unknown>>();
    private checkedDates = new WeakMap<object, number>();

    /**
     * Expiration and landing share this queue so a date check in flight
     * cannot skip the landing that should complete the same mission.
     */
    private runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
        const previous = this.entryWork.get(key) ?? Promise.resolve();
        const next = previous.then(work, work);
        this.entryWork.set(key, next);
        void next.finally(() => {
            if (this.entryWork.get(key) === next) {
                this.entryWork.delete(key);
            }
        });
        return next;
    }

    // TODO: Validate mission mutations on the server before accepting
    // untrusted client-side state as authoritative.
    constructor(private readonly gameData: GameDataInterface) { }

    private getMission(id: string): Promise<MissionData | undefined> {
        const cached = this.missionCache.get(id);
        if (cached) {
            return cached;
        }
        const promise = (async () => {
            const missions = this.gameData.data.Mission;
            if (!missions) {
                return undefined;
            }
            try {
                return await missions.get(id);
            } catch (error) {
                console.warn(`Could not load mission ${id}`, error);
                return undefined;
            }
        })();
        this.missionCache.set(id, promise);
        return promise;
    }

    private async getMissionForEntry(
        entry: ActiveMission,
    ): Promise<MissionData | undefined> {
        let missionData: unknown;
        let missionId: string | undefined;
        try {
            missionData = entry?.missionData;
            missionId = entry?.missionId;
        } catch {
            return undefined;
        }
        if (missionData && typeof missionData === 'object') {
            return missionData as MissionData;
        }
        if (missionId) {
            return this.getMission(missionId);
        }
        return undefined;
    }

    private async missionName(
        destination: string | undefined,
    ): Promise<string> {
        if (!destination || destination === '*') {
            return 'any destination';
        }
        try {
            return (await this.gameData.data.Planet.get(destination)).name;
        } catch {
            return destination;
        }
    }

    checkDate(
        state: PlayerState,
        context: MissionSetContext = {},
    ): Promise<void> | undefined {
        try {
            if (this.checkedDates.get(state) === state.gameDate) {
                return undefined;
            }
            this.checkedDates.set(state, state.gameDate);
        } catch {
            // Ignore if state proxy is invalid
        }
        return this.failExpired(state, context).catch(error => {
            console.error('Mission expiration processing failed', error);
        });
    }

    /**
     * Mark overdue missions failed. The async-system caller supplies an Immer
     * draft, so mutations made after data loading are safely turned into ECS
     * patches.
     */
    async failExpired(
        state: PlayerState,
        context: MissionSetContext = {},
    ): Promise<void> {
        let entries: ActiveMission[];
        try {
            entries = [...state.activeMissions];
        } catch {
            return;
        }

        const tasks: Array<{
            entry: ActiveMission;
            missionId: string;
            missionData?: unknown;
            key: string;
        }> = [];

        for (const entry of entries) {
            try {
                if (entry.state !== 'active' || entry.acceptedDate === undefined) {
                    continue;
                }
                tasks.push({
                    entry,
                    missionId: entry.missionId,
                    missionData: entry.missionData,
                    key: missionEntryKey(entry),
                });
            } catch {
                continue;
            }
        }

        await Promise.all(tasks.map(task => {
            return this.runExclusive(task.key, async () => {
                let mission: MissionData | undefined;
                try {
                    if (task.missionData && typeof task.missionData === 'object') {
                        mission = task.missionData as MissionData;
                    } else if (task.missionId) {
                        mission = await this.getMission(task.missionId);
                    }
                } catch {
                    return;
                }
                if (!mission) {
                    return;
                }

                try {
                    if (task.entry.state !== 'active'
                        || !isExpired(state, task.entry, mission)) {
                        return;
                    }
                    runMissionSetExpression(mission.onFailure, state, console.warn,
                        context);
                    task.entry.state = 'failed';
                    releaseMissionCargo(state, task.missionId);
                    await startPendingNcbMissions(this.gameData, state, {
                        initialPlanetId: state.lastLandedPlanet,
                        initialSystemId: state.currentSystem,
                        currentSystemId: state.currentSystem,
                        ncb: context,
                    });
                } catch (error) {
                    console.warn('Mission expiration could not be applied', error);
                }
            });
        }));
    }

    /**
     * Resolve missions at a landing. Failed missions are held until this
     * method is called so their FailText can be shown on the next landing.
     */
    async processLanding(
        state: PlayerState,
        planetId: string,
        context: MissionSetContext = {},
    ): Promise<MissionNotice[]> {
        await this.failExpired(state, context);
        const notices: MissionNotice[] = [];
        const entries = [...state.activeMissions];
        for (const entry of entries) {
            await this.runExclusive(missionEntryKey(entry), async () => {
                const mission = await this.getMissionForEntry(entry);
                if (!mission) {
                    return;
                }
                if (entry.state === 'failed') {
                    const destinationName = await this.missionName(
                        missionTravelDestination(entry));
                    const returnDestinationName = await this.missionName(
                        entry.returnDestination ?? entry.destination);
                    notices.push({
                        missionId: entry.missionId,
                        kind: 'failure',
                        text: formatMissionText(
                            mission.failText || 'Mission failed.',
                            missionTextValues(
                                state, entry, mission,
                                destinationName, returnDestinationName),
                        ),
                    });
                    this.removeEntry(state, entry);
                    return;
                }

                if (entry.state !== 'active') {
                    return;
                }
                const atTravel = destinationMatches(
                    missionTravelDestination(entry), planetId);
                if (atTravel) {
                    entry.travelVisited = true;
                }
                if (atTravel && pickupAtTravel(mission) && entry.cargo
                    && !missionHoldsCargo(state, entry.missionId)) {
                    if (getFreeSpace(state) < entry.cargo.quantity
                        || !allocateCargo(state, {
                            commodity: entry.missionId,
                            tons: entry.cargo.quantity,
                            isMissionCargo: true,
                        })) {
                        return;
                    }
                    // Pickup and drop-off are different landings.
                    return;
                }
                if (!landingCompletesMission(entry, mission, planetId)) {
                    return;
                }

                let goalProgress = missionGoalProgress(entry, mission);
                if (goalProgress?.goal === 3 && !goalProgress.completed) {
                    goalProgress = advanceMissionGoal(
                        goalProgress, 'escortSafe');
                    entry.shipGoalProgress = goalProgress;
                }
                if (goalProgress && !goalProgress.completed) {
                    return;
                }

                if (goalProgress && !goalProgress.shipDoneApplied) {
                    goalProgress.shipDoneApplied = true;
                    runMissionSetExpression(
                        mission.onShipDone, state, console.warn, context);
                }
                // EV Nova Bible, mïsn/OnSuccess: "Control bit set expression
                // which is evaluated when the mission is completed successfully."
                runMissionSetExpression(
                    mission.onSuccess, state, console.warn, context);
                applyMissionCompletionRewards(state, mission);
                const destinationName = await this.missionName(
                    missionTravelDestination(entry));
                const returnDestinationName = await this.missionName(
                    entry.returnDestination ?? entry.destination);
                notices.push({
                    missionId: entry.missionId,
                    kind: 'success',
                    text: formatMissionText(
                        mission.compText || 'Mission complete.',
                        missionTextValues(
                            state, entry, mission,
                            destinationName, returnDestinationName),
                        ),
                    });
                this.removeEntry(state, entry);
                await startPendingNcbMissions(this.gameData, state, {
                    initialPlanetId: planetId,
                    initialSystemId: state.currentSystem,
                    currentSystemId: state.currentSystem,
                    ncb: context,
                });
            });
        }
        return notices;
    }

    /**
     * Record a server-observed special-ship event. The counters live on the
     * player state so they are sent to the owning client and survive a
     * reconnect; only the server calls this method for live ECS events.
     */
    async recordShipGoal(
        state: PlayerState,
        missionUuid: string,
        event: MissionGoalEvent,
        context: MissionSetContext = {},
    ): Promise<boolean> {
        const entry = state.activeMissions.find(candidate =>
            candidate.state === 'active'
            && (activeMissionUuid(candidate) === missionUuid
                || candidate.missionId === missionUuid));
        if (!entry) {
            return false;
        }
        const mission = await this.getMissionForEntry(entry);
        if (!mission) {
            return false;
        }
        const progress = missionGoalProgress(entry, mission);
        if (!progress) {
            return false;
        }
        if (event === 'chasedOff' && mission.shipGoal !== 6) {
            return false;
        }
        // A destroyed escort counts as lost. Destroyed targets count toward
        // both destroy-all and chase-off goals.
        const effectiveEvent = mission.shipGoal === 3
            && event === 'destroyed' ? 'lost' : event;
        entry.shipGoalProgress = advanceMissionGoal(
            progress, effectiveEvent);
        if (mission.shipGoal === 3 && effectiveEvent === 'lost') {
            // EV Nova Bible, mïsn/ShipGoal 3:
            // "Escort them (keep them from getting killed)."
            runMissionSetExpression(
                mission.onFailure, state, console.warn, context);
            entry.state = 'failed';
            releaseMissionCargo(state, entry.missionId);
            await startPendingNcbMissions(this.gameData, state, {
                initialPlanetId: state.lastLandedPlanet,
                initialSystemId: state.currentSystem,
                currentSystemId: state.currentSystem,
                ncb: context,
            });
            return false;
        }
        if (entry.shipGoalProgress.completed
            && !entry.shipGoalProgress.shipDoneApplied) {
            entry.shipGoalProgress.shipDoneApplied = true;
            runMissionSetExpression(
                mission.onShipDone, state, console.warn, context);
            await startPendingNcbMissions(this.gameData, state, {
                initialPlanetId: state.lastLandedPlanet,
                initialSystemId: state.currentSystem,
                currentSystemId: state.currentSystem,
                ncb: context,
            });
        }
        return entry.shipGoalProgress.completed;
    }

    private removeEntry(state: PlayerState, entry: ActiveMission) {
        releaseMissionCargo(state, entry.missionId);
        const index = state.activeMissions.indexOf(entry);
        if (index >= 0) {
            state.activeMissions.splice(index, 1);
        }
    }

    async getMissionForDisplay(id: string) {
        return this.getMission(id);
    }
}

export const MissionRuntimeResource =
    new Resource<MissionRuntime>('MissionRuntimeResource');

const MissionExpirationSystem = new AsyncSystem({
    name: 'MissionExpirationSystem',
    exclusive: true,
    skipIfApplyingPatches: true,
    args: [
        PlayerShipSelector,
        GetEntity,
        Optional(PlayerStateComponent),
        MissionRuntimeResource,
        NcbRuntimeResource,
    ] as const,
    async step(_playerShip, playerShip, state, missionRuntime, ncbRuntime) {
        if (!playerShip || !state) {
            return;
        }
        const context = ncbRuntime.setContext(playerShip, state);
        await missionRuntime.checkDate(state, context);
    },
});

export const MissionPlugin: Plugin = {
    name: 'MissionPlugin',
    build(world) {
        const gameData = world.resources.get(GameDataResource);
        if (!gameData) {
            throw new Error('MissionPlugin requires GameDataResource');
        }
        world.resources.set(
            MissionRuntimeResource,
            new MissionRuntime(gameData),
        );
        world.resources.set(
            NcbRuntimeResource,
            new NcbRuntime(gameData),
        );
        world.addComponent(PendingMissionJumpComponent);
        world.addComponent(PendingMissionSoundComponent);
        world.addSystem(MissionJumpSystem);
        world.addSystem(MissionSoundSystem);
        world.addSystem(MissionExpirationSystem);
    },
    remove(world) {
        world.removeSystem(MissionJumpSystem);
        world.removeSystem(MissionSoundSystem);
        world.removeSystem(MissionExpirationSystem);
    },
};
