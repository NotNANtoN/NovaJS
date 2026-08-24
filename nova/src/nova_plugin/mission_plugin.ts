import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { MissionData } from 'novadatainterface/MissionData';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { PlayerShipSelector } from './player_ship_plugin';
import { GameDataResource } from './game_data_resource';
import {
    executeSetOperations,
    NcbOperation,
    parseSetExpression,
} from './ncb';
import {
    ActiveMission,
    allocateCargo,
    getFreeSpace,
    MAX_ACTIVE_MISSIONS,
    MissionCargo,
    PlayerState,
    PlayerStateComponent,
    releaseMissionCargo,
    formatGameDate,
} from './player_state';
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
}

export interface ResolvedMissionDestinations {
    travelDestination: string | '*';
    returnDestination: string | '*';
    shipSystem?: string;
}

export interface MissionTextValues {
    destination?: string;
    destinationSystem?: string;
    returnDestination?: string;
    returnSystem?: string;
    cargo?: string;
    quantity?: number;
    deadline?: string | number;
    pay?: number | string;
}

/**
 * Replace the mission wildcards documented in the EV Nova Bible.
 *
 * The full Nova text formatter also knows about player/rank/ship fields. Those
 * values are not represented by PlayerState yet, so unknown tags are removed
 * rather than displayed literally.
 */
export function formatMissionText(
    text: string,
    values: MissionTextValues = {},
): string {
    const destination = values.destination ?? '';
    const returnDestination = values.returnDestination ?? destination;
    const replacements: Record<string, string> = {
        DSY: values.destinationSystem ?? destination,
        DST: destination,
        RSY: values.returnSystem ?? returnDestination,
        RST: returnDestination,
        // RET is accepted as a friendly alias used by some converted data.
        RET: returnDestination,
        CT: values.cargo ?? '',
        CQ: values.quantity === undefined ? '' : String(values.quantity),
        DL: values.deadline === undefined ? '' : String(values.deadline),
        PAY: values.pay === undefined ? '' : String(values.pay),
    };

    return text
        .replace(/<([A-Z]{2,3})>/gi, (_whole, rawKey: string) =>
            replacements[rawKey.toUpperCase()] ?? '')
        .replace(/<[^>]*>/g, '');
}

function noOpMissionOperation(operation: NcbOperation) {
    console.warn(`Mission operation '${operation.type}' is not implemented yet`);
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
        return `nova:${selector}`;
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
        const systemResolution = resolveSystemSelector(mission.shipSyst, {
            ...baseContext,
            travelPlanetId: travelDestination === '*' ? undefined : travelDestination,
            returnPlanetId: returnDestination === '*' ? undefined : returnDestination,
        });
        shipSystem = systemResolution.selected;
        if (!shipSystem && options.systems === undefined
            && mission.shipSyst >= 128 && mission.shipSyst <= 2175) {
            shipSystem = `nova:${mission.shipSyst}`;
        }
        if (!shipSystem) {
            return undefined;
        }
    }

    return { travelDestination, returnDestination, shipSystem };
}

function runMissionSetExpression(
    expression: string,
    state: PlayerState,
    logger: (message: string) => void = console.warn,
) {
    if (!expression.trim()) {
        return;
    }

    try {
        const operations = parseSetExpression(expression, { logger });
        const handlers = {
            abortMission: noOpMissionOperation,
            failMission: noOpMissionOperation,
            startMission: noOpMissionOperation,
            grantOutfit: noOpMissionOperation,
            removeOutfit: noOpMissionOperation,
            moveToSystem: noOpMissionOperation,
            moveToSystemRelative: noOpMissionOperation,
            changeShip: noOpMissionOperation,
            activateRank: noOpMissionOperation,
            deactivateRank: noOpMissionOperation,
            playSound: noOpMissionOperation,
            destroyStellar: noOpMissionOperation,
            regenerateStellar: noOpMissionOperation,
            leaveStellar: noOpMissionOperation,
            renameShip: noOpMissionOperation,
            exploreSystem: noOpMissionOperation,
        };
        executeSetOperations(operations, state.missionBits, {
            handlers,
            logger,
        });
    } catch (error) {
        logger(`Could not execute mission set expression '${expression}': ${error}`);
    }
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
    if (mission.shipGoal >= 0) {
        console.warn(`Combat mission ${mission.id} is not offered in phase one`);
        return undefined;
    }
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
    const destination = mission.returnStel === -1 && mission.dropOffMode === 0
        ? resolved.travelDestination
        : resolved.returnDestination;

    const cargo = missionCargo(mission, pickupDestination);
    if (cargo && getFreeSpace(state) < cargo.quantity) {
        console.warn(`Cannot accept mission ${mission.id}: not enough cargo space`);
        return undefined;
    }
    if (cargo && !allocateCargo(state, {
        commodity: mission.id,
        tons: cargo.quantity,
        isMissionCargo: true,
    })) {
        console.warn(`Cannot accept mission ${mission.id}: cargo allocation failed`);
        return undefined;
    }
    runMissionSetExpression(mission.onAccept, state, options.logger);
    const activeMission: ActiveMission = {
        missionId: mission.id,
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
    };
    state.activeMissions.push(activeMission);
    return activeMission;
}

export function refuseMission(
    state: PlayerState,
    mission: MissionData,
    logger?: (message: string) => void,
) {
    runMissionSetExpression(mission.onRefuse, state, logger);
}

export function abortMission(
    state: PlayerState,
    entry: ActiveMission,
    mission: MissionData,
    logger?: (message: string) => void,
): boolean {
    if (!mission.canAbort || entry.state !== 'active') {
        return false;
    }
    runMissionSetExpression(mission.onAbort, state, logger);
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
    };
}

export class MissionRuntime {
    private missionCache = new Map<string, Promise<MissionData | undefined>>();
    private inFlight = new Set<string>();
    private checkedDates = new WeakMap<object, number>();

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
        if (entry.missionData && typeof entry.missionData === 'object') {
            return entry.missionData as MissionData;
        }
        return this.getMission(entry.missionId);
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

    checkDate(state: PlayerState) {
        if (this.checkedDates.get(state) === state.gameDate) {
            return;
        }
        this.checkedDates.set(state, state.gameDate);
        void this.failExpired(state).catch(error =>
            console.error('Mission expiration processing failed', error));
    }

    /**
     * Mark overdue missions failed. The async-system caller supplies an Immer
     * draft, so mutations made after data loading are safely turned into ECS
     * patches.
     */
    async failExpired(state: PlayerState): Promise<void> {
        const entries = [...state.activeMissions];
        for (const entry of entries) {
            if (entry.state !== 'active' || entry.acceptedDate === undefined) {
                continue;
            }
            const key = `${entry.missionId}:${entry.acceptedDate}`;
            if (this.inFlight.has(key)) {
                continue;
            }
            this.inFlight.add(key);
            try {
                const mission = await this.getMissionForEntry(entry);
                if (!mission || !isExpired(state, entry, mission)) {
                    continue;
                }
                runMissionSetExpression(mission.onFailure, state);
                entry.state = 'failed';
                releaseMissionCargo(state, entry.missionId);
            } finally {
                this.inFlight.delete(key);
            }
        }
    }

    /**
     * Resolve missions at a landing. Failed missions are held until this
     * method is called so their FailText can be shown on the next landing.
     */
    async processLanding(
        state: PlayerState,
        planetId: string,
    ): Promise<MissionNotice[]> {
        await this.failExpired(state);
        const notices: MissionNotice[] = [];
        const entries = [...state.activeMissions];
        for (const entry of entries) {
            const key = `${entry.missionId}:${entry.acceptedDate ?? 'legacy'}`;
            if (this.inFlight.has(key)) {
                continue;
            }
            this.inFlight.add(key);
            try {
                const mission = await this.getMissionForEntry(entry);
                if (!mission) {
                    continue;
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
                    continue;
                }

                if (entry.state !== 'active'
                    || !destinationMatches(entry.destination, planetId)) {
                    continue;
                }

                runMissionSetExpression(mission.onSuccess, state);
                if (mission.payVal > 0) {
                    state.credits += mission.payVal;
                } else if (mission.payVal < -1) {
                    console.warn(`Mission pay value ${mission.payVal} is not implemented`);
                }
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
            } finally {
                this.inFlight.delete(key);
            }
        }
        return notices;
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

const MissionExpirationSystem = new System({
    name: 'MissionExpiration',
    args: [
        PlayerShipSelector,
        Optional(PlayerStateComponent),
        MissionRuntimeResource,
    ] as const,
    step(_playerShip, state, runtime) {
        if (state) {
            runtime.checkDate(state);
        }
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
        world.addSystem(MissionExpirationSystem);
    },
};
