import { isDraft, original } from 'immer';
import type { GameDataInterface } from 'novadatainterface/GameDataInterface';
import type { SystemData } from 'novadatainterface/SystemData';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import {
    MovementPhysicsComponent,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { wallClockNow } from 'nova_ecs/plugins/time_plugin';
import {
    ConquestBotComponent,
    isConquestMode,
    isConquestPocketSystem,
} from './conquest_config';
import { DerelictComponent } from './derelict_component';
import { DestructionStartedComponent } from './destruction_state';
import {
    CommandedEscortComponent,
    GovtComponent,
    NpcAIComponent,
    NpcCombatRole,
    NpcCombatRoleComponent,
} from './npc_components';
import type { TrafficPhase } from './npc_traffic';
import type { PersInstance } from './pers_plugin';

export const MAX_CACHED_SYSTEMS = 64;
export const SYSTEM_STATE_TTL_MS = 10 * 60 * 1_000;
export const MAX_TRANSFERS_PER_SYSTEM = 24;
export const STORYLINE_TRANSFER_TTL_MS = 3 * 60 * 1_000;
export const NATURAL_RESPAWN_CADENCE_MS = 9_000;

const TRACKER_JUMP_ARRIVAL_RADIUS = 1_400;
const TRACKER_JUMP_ARRIVAL_SPEED_MULTIPLIER = 3;
const TRACKER_SYSTEM_DEPARTURE_RADIUS = 7_000;
const TRACKER_DEFAULT_PATROL_RADIUS = 900;

export interface TrackedNpcShip {
    uuid: string;
    shipId: string;
    name?: string;
    government: number;
    combatRole: NpcCombatRole;
    dudeId?: string;
    persInstance?: PersInstance;
    position: [number, number];
    velocity: [number, number];
    rotation: number;
    maxVelocity: number;
    shieldRatio: number;
    armorRatio: number;
    disabled: boolean;
    patrolPost?: [number, number];
    patrolRadius?: number;
    trafficPhase?: TrafficPhase;
    trafficDestination?: string;
    launchedFromPlanetId?: string;
    jumpingTo?: string;
    fleetId?: string;
    leaderUuid?: string;
    fleetRole?: 'leader' | 'escort';
    fleetSlot?: number;
}

export interface CachedSystemState {
    systemId: string;
    savedAt: number;
    targetCount: number;
    ships: TrackedNpcShip[];
}

export interface StorylineNpcTransfer {
    uuid: string;
    from: string;
    to: string;
    departedAt: number;
    departurePosition: [number, number];
    ship: TrackedNpcShip;
}

export interface TransferArrivalPlacement {
    position: [number, number];
    velocity: [number, number];
    rotation: number;
    arriving: boolean;
    from: string;
    to: string;
}

interface SystemStateStore {
    systems: Map<string, CachedSystemState>;
    transfersBySystem: Map<string, StorylineNpcTransfer[]>;
}

const storeByGameData = new WeakMap<object, SystemStateStore>();
const defaultStore: SystemStateStore = {
    systems: new Map(),
    transfersBySystem: new Map(),
};

function unwrapKey(gameData?: object): object | undefined {
    if (!gameData || typeof gameData !== 'object') {
        return undefined;
    }
    return isDraft(gameData) ? (original(gameData) ?? gameData) : gameData;
}

function getStore(gameData?: object): SystemStateStore {
    const key = unwrapKey(gameData);
    if (!key) {
        return defaultStore;
    }
    let store = storeByGameData.get(key);
    if (!store) {
        store = {
            systems: new Map(),
            transfersBySystem: new Map(),
        };
        storeByGameData.set(key, store);
    }
    return store;
}

export function resetSystemStateTracker(gameData?: object): void {
    defaultStore.systems.clear();
    defaultStore.transfersBySystem.clear();
    const key = unwrapKey(gameData);
    if (key) {
        storeByGameData.delete(key);
    }
}

export function extractTrackedNpcShip(
    uuid: string,
    entity: Entity,
): TrackedNpcShip | undefined {
    if (!entity.components.has(NpcAIComponent)) {
        return undefined;
    }
    const multiplayer = entity.components.get(MultiplayerData);
    if (multiplayer?.owner !== 'server') {
        return undefined;
    }
    if (
        entity.components.has(ConquestBotComponent)
        || entity.components.has(DerelictComponent)
        || entity.components.has(CommandedEscortComponent)
        || entity.components.has(DestructionStartedComponent)
    ) {
        return undefined;
    }

    const movement = entity.components.get(MovementStateComponent);
    if (!movement) {
        return undefined;
    }

    let shipId: string | undefined;
    let shieldRatio = 1;
    let armorRatio = 1;
    let disabled = false;
    let dudeId: string | undefined;
    let persInstance: PersInstance | undefined;
    let patrolPost: [number, number] | undefined;
    let patrolRadius: number | undefined;
    let trafficPhase: TrafficPhase | undefined;
    let trafficDestination: string | undefined;
    let launchedFromPlanetId: string | undefined;
    let jumpingTo: string | undefined;
    let fleetId: string | undefined;
    let leaderUuid: string | undefined;
    let fleetRole: 'leader' | 'escort' | undefined;
    let fleetSlot: number | undefined;

    for (const [comp, val] of entity.components.entries()) {
        const v = val as any;
        switch (comp.name) {
            case 'PlayerState':
            case 'MissionShip':
            case 'HiredEscortComponent':
                return undefined;
            case 'Ship':
                shipId = v?.id;
                break;
            case 'Armor':
                if (v && typeof v.current === 'number') {
                    if (v.current <= 0) {
                        return undefined;
                    }
                    if (v.max > 0) {
                        armorRatio = Math.max(0.05, Math.min(1, v.current / v.max));
                    }
                }
                break;
            case 'Shield':
                if (v && typeof v.current === 'number' && v.max > 0) {
                    shieldRatio = Math.max(0, Math.min(1, v.current / v.max));
                }
                break;
            case 'DisabledComponent':
                disabled = Boolean(v);
                break;
            case 'DudeSource':
                dudeId = v?.id;
                break;
            case 'PersComponent':
                if (v?.data && v?.state) {
                    persInstance = {
                        data: v.data,
                        state: { ...v.state },
                    };
                }
                break;
            case 'PatrolComponent':
                if (v?.guardPost) {
                    patrolPost = [v.guardPost[0], v.guardPost[1]];
                    patrolRadius = v.radius;
                }
                break;
            case 'NpcTrafficComponent':
                trafficPhase = v?.phase;
                trafficDestination = v?.destination;
                launchedFromPlanetId = v?.launchedFromPlanetId;
                break;
            case 'JumpStateComponent':
                if (v && v.phase !== 'arriving' && v.to) {
                    jumpingTo = v.to;
                }
                break;
            case 'FleetMemberComponent':
                fleetId = v?.fleetId;
                leaderUuid = v?.leaderUuid;
                fleetRole = v?.role;
                fleetSlot = v?.slot;
                break;
        }
    }

    if (!shipId) {
        return undefined;
    }

    const physics = entity.components.get(MovementPhysicsComponent);
    const govt = entity.components.get(GovtComponent);
    const combatRole = entity.components.get(NpcCombatRoleComponent) ?? 'personal';

    return {
        uuid,
        shipId,
        name: entity.name,
        government: govt?.id ?? -1,
        combatRole,
        dudeId,
        persInstance,
        position: [movement.position.x, movement.position.y],
        velocity: [movement.velocity.x, movement.velocity.y],
        rotation: movement.rotation.angle,
        maxVelocity: Math.max(40, physics?.maxVelocity ?? 200),
        shieldRatio,
        armorRatio,
        disabled,
        patrolPost,
        patrolRadius,
        trafficPhase,
        trafficDestination,
        launchedFromPlanetId,
        jumpingTo,
        fleetId,
        leaderUuid,
        fleetRole,
        fleetSlot,
    };
}

export function enqueueStorylineNpcTransfer(
    gameData: object | undefined,
    transfer: StorylineNpcTransfer,
): void {
    if (!transfer.from || !transfer.to || transfer.from === transfer.to) {
        return;
    }
    const store = getStore(gameData);
    // Remove from source system's cached snapshot so a ship that jumped out
    // ceases to exist in the source system.
    const sourceCached = store.systems.get(transfer.from);
    if (sourceCached) {
        sourceCached.ships = sourceCached.ships.filter(
            s => s.uuid !== transfer.uuid,
        );
    }

    let queue = store.transfersBySystem.get(transfer.to);
    if (!queue) {
        queue = [];
        store.transfersBySystem.set(transfer.to, queue);
    }
    const existingIdx = queue.findIndex(item => item.uuid === transfer.uuid);
    if (existingIdx >= 0) {
        queue.splice(existingIdx, 1);
    }
    if (queue.length >= MAX_TRANSFERS_PER_SYSTEM) {
        queue.shift();
    }
    queue.push({
        ...transfer,
        departurePosition: [
            transfer.departurePosition[0],
            transfer.departurePosition[1],
        ],
        ship: {
            ...transfer.ship,
            position: [transfer.ship.position[0], transfer.ship.position[1]],
            velocity: [transfer.ship.velocity[0], transfer.ship.velocity[1]],
            jumpingTo: undefined,
        },
    });
}

export function recordStorylineNpcJumpDeparture(
    gameData: object | undefined,
    entity: Entity,
    uuid: string,
    from: string,
    to: string,
    departurePosition: [number, number],
    now = wallClockNow(),
): boolean {
    if (!from || !to || from === to) {
        return false;
    }
    const tracked = extractTrackedNpcShip(uuid, entity);
    if (!tracked) {
        return false;
    }
    enqueueStorylineNpcTransfer(gameData, {
        uuid,
        from,
        to,
        departedAt: now,
        departurePosition,
        ship: tracked,
    });
    return true;
}

export function hasPendingStorylineNpcTransfers(
    gameData: object | undefined,
    systemId: string,
    now = wallClockNow(),
): boolean {
    const store = getStore(gameData);
    const queue = store.transfersBySystem.get(systemId);
    if (!queue || queue.length === 0) {
        return false;
    }
    return queue.some(t => now - t.departedAt <= STORYLINE_TRANSFER_TTL_MS);
}

export function drainStorylineNpcTransfers(
    gameData: object | undefined,
    systemId: string,
    now = wallClockNow(),
): StorylineNpcTransfer[] {
    const store = getStore(gameData);
    const queue = store.transfersBySystem.get(systemId);
    if (!queue || queue.length === 0) {
        return [];
    }
    store.transfersBySystem.delete(systemId);
    return queue.filter(t => now - t.departedAt <= STORYLINE_TRANSFER_TTL_MS);
}

export function findAlignedNeighbourLink(
    gameData: GameDataInterface | undefined,
    systemId: string,
    systemData: SystemData | undefined,
    headingX: number,
    headingY: number,
    minAlignment = 0.72,
): string | undefined {
    const sys = systemData ?? gameData?.data?.System?.getCached?.(systemId);
    const links = sys?.links ?? [];
    if (!sys?.position || links.length === 0) {
        return undefined;
    }
    const norm = Math.hypot(headingX, headingY);
    if (norm <= 1e-5) {
        return undefined;
    }
    const ux = headingX / norm;
    const uy = headingY / norm;
    let bestLink: string | undefined;
    let bestDot = minAlignment;
    for (const link of links) {
        const neighbour = gameData?.data?.System?.getCached?.(link);
        if (!neighbour?.position) {
            continue;
        }
        const dx = neighbour.position[0] - sys.position[0];
        const dy = neighbour.position[1] - sys.position[1];
        const len = Math.hypot(dx, dy);
        if (len <= 1e-5) {
            continue;
        }
        const dot = (dx / len) * ux + (dy / len) * uy;
        if (dot >= bestDot) {
            bestDot = dot;
            bestLink = link;
        }
    }
    return bestLink;
}

function hasConquestModePlayerInWorld(world: World): boolean {
    for (const entity of world.entities.values()) {
        for (const [comp, val] of entity.components.entries()) {
            if (comp.name === 'PlayerState' && isConquestMode(val as any)) {
                return true;
            }
        }
    }
    return false;
}

export function captureSystemNpcState(
    gameData: GameDataInterface | undefined,
    world: World,
    systemId: string,
    targetCount: number,
    now = wallClockNow(),
    playerJumpingTo?: string,
): void {
    if (!systemId) {
        return;
    }
    if (isConquestPocketSystem(systemId) && hasConquestModePlayerInWorld(world)) {
        return;
    }

    const systemData = gameData?.data?.System?.getCached?.(systemId);
    const surviving: TrackedNpcShip[] = [];

    for (const [uuid, entity] of world.entities.entries()) {
        const tracked = extractTrackedNpcShip(uuid, entity);
        if (!tracked) {
            continue;
        }

        // 1. If the ship is already in a hyperspace jump to another system,
        // transfer it to that destination system so a player following it sees it.
        if (tracked.jumpingTo && tracked.jumpingTo !== systemId) {
            enqueueStorylineNpcTransfer(gameData, {
                uuid,
                from: systemId,
                to: tracked.jumpingTo,
                departedAt: now,
                departurePosition: [tracked.position[0], tracked.position[1]],
                ship: tracked,
            });
            continue;
        }

        // 2. If the ship is flying outward on a trajectory aligned with a linked
        // neighbour system (especially one a player is jumping to follow),
        // promote it to a transfer along that bearing if it is heading outward.
        const speed = Math.hypot(tracked.velocity[0], tracked.velocity[1]);
        const dirX = speed > 5 ? tracked.velocity[0] / speed : Math.sin(tracked.rotation);
        const dirY = speed > 5 ? tracked.velocity[1] / speed : -Math.cos(tracked.rotation);
        const distFromCenter = Math.hypot(tracked.position[0], tracked.position[1]);
        const radialDot = tracked.position[0] * dirX + tracked.position[1] * dirY;
        const movingOutward = distFromCenter < 250 || radialDot >= 0;

        if (
            !tracked.disabled
            && !tracked.patrolPost
            && tracked.trafficPhase !== 'docked'
            && movingOutward
        ) {
            const alignedLink = findAlignedNeighbourLink(
                gameData,
                systemId,
                systemData,
                dirX,
                dirY,
                0.75,
            );
            const followingIntoLink = Boolean(
                playerJumpingTo
                && alignedLink === playerJumpingTo
                && (speed > 10 || tracked.trafficPhase === 'departing'),
            );
            const departingAtEdge = Boolean(
                alignedLink
                && (distFromCenter >= 1_200 || tracked.trafficPhase === 'departing'),
            );
            if (alignedLink && (followingIntoLink || departingAtEdge)) {
                enqueueStorylineNpcTransfer(gameData, {
                    uuid,
                    from: systemId,
                    to: alignedLink,
                    departedAt: now,
                    departurePosition: [tracked.position[0], tracked.position[1]],
                    ship: tracked,
                });
                continue;
            }
        }

        surviving.push(tracked);
    }

    const store = getStore(gameData);
    const previousTarget = store.systems.get(systemId)?.targetCount ?? 0;
    const effectiveTarget = targetCount > 0 ? targetCount : previousTarget;
    // Maintain LRU insertion order
    store.systems.delete(systemId);
    if (store.systems.size >= MAX_CACHED_SYSTEMS) {
        const oldestKey = store.systems.keys().next().value;
        if (oldestKey !== undefined) {
            store.systems.delete(oldestKey);
        }
    }
    store.systems.set(systemId, {
        systemId,
        savedAt: now,
        targetCount: Math.max(0, effectiveTarget),
        ships: surviving,
    });
}

export function getCachedSystemState(
    gameData: object | undefined,
    systemId: string,
    now = wallClockNow(),
): CachedSystemState | undefined {
    const store = getStore(gameData);
    const cached = store.systems.get(systemId);
    if (!cached) {
        return undefined;
    }
    if (now - cached.savedAt > SYSTEM_STATE_TTL_MS) {
        store.systems.delete(systemId);
        return undefined;
    }
    return cached;
}

export function consumeCachedSystemState(
    gameData: object | undefined,
    systemId: string,
    now = wallClockNow(),
): CachedSystemState | undefined {
    const store = getStore(gameData);
    const cached = store.systems.get(systemId);
    if (!cached) {
        return undefined;
    }
    store.systems.delete(systemId);
    if (now - cached.savedAt > SYSTEM_STATE_TTL_MS) {
        return undefined;
    }
    return cached;
}

export function advanceCachedSystemState(
    gameData: GameDataInterface | undefined,
    cached: CachedSystemState,
    systemData: SystemData | undefined,
    now = wallClockNow(),
): {
    survivingShips: TrackedNpcShip[];
    departedTransfers: StorylineNpcTransfer[];
    naturalReplacements: number;
} {
    const elapsedMs = Math.max(0, now - cached.savedAt);
    const dtSeconds = elapsedMs / 1_000;
    const survivingShips: TrackedNpcShip[] = [];
    const departedTransfers: StorylineNpcTransfer[] = [];

    for (const rawShip of cached.ships) {
        const ship: TrackedNpcShip = {
            ...rawShip,
            position: [rawShip.position[0], rawShip.position[1]],
            velocity: [rawShip.velocity[0], rawShip.velocity[1]],
        };

        if (ship.jumpingTo && ship.jumpingTo !== cached.systemId) {
            const transfer: StorylineNpcTransfer = {
                uuid: ship.uuid,
                from: cached.systemId,
                to: ship.jumpingTo,
                departedAt: cached.savedAt + Math.min(elapsedMs, 1_500),
                departurePosition: [ship.position[0], ship.position[1]],
                ship: { ...ship, jumpingTo: undefined },
            };
            departedTransfers.push(transfer);
            enqueueStorylineNpcTransfer(gameData, transfer);
            continue;
        }

        if (ship.disabled) {
            // Disabled derelicts/hulks drift slowly and remain where the player left them
            ship.position = [
                ship.position[0] + ship.velocity[0] * Math.min(dtSeconds, 30) * 0.2,
                ship.position[1] + ship.velocity[1] * Math.min(dtSeconds, 30) * 0.2,
            ];
            survivingShips.push(ship);
            continue;
        }

        if (ship.patrolPost) {
            // Advance military ship around its planetary guard post orbit
            const radius = ship.patrolRadius ?? TRACKER_DEFAULT_PATROL_RADIUS;
            const relX = ship.position[0] - ship.patrolPost[0];
            const relY = ship.position[1] - ship.patrolPost[1];
            const currentAngle = Math.atan2(relY, relX);
            const cruiseSpeed = Math.max(50, ship.maxVelocity * 0.65);
            const angularVel = cruiseSpeed / Math.max(200, radius);
            const nextAngle = currentAngle + angularVel * dtSeconds;
            ship.position = [
                ship.patrolPost[0] + Math.cos(nextAngle) * radius,
                ship.patrolPost[1] + Math.sin(nextAngle) * radius,
            ];
            const tangentX = -Math.sin(nextAngle);
            const tangentY = Math.cos(nextAngle);
            ship.velocity = [tangentX * cruiseSpeed, tangentY * cruiseSpeed];
            ship.rotation = Math.atan2(tangentX, -tangentY);
            survivingShips.push(ship);
            continue;
        }

        // Open-space or trader ship: dead-reckon along velocity / heading
        const currentSpeed = Math.hypot(ship.velocity[0], ship.velocity[1]);
        const cruiseSpeed = currentSpeed > 15
            ? currentSpeed
            : Math.max(60, ship.maxVelocity * 0.75);
        const dirX = currentSpeed > 15
            ? ship.velocity[0] / currentSpeed
            : Math.sin(ship.rotation);
        const dirY = currentSpeed > 15
            ? ship.velocity[1] / currentSpeed
            : -Math.cos(ship.rotation);

        const nextX = ship.position[0] + dirX * cruiseSpeed * dtSeconds;
        const nextY = ship.position[1] + dirY * cruiseSpeed * dtSeconds;
        const nextDist = Math.hypot(nextX, nextY);
        const radialDot = nextX * dirX + nextY * dirY;

        if (
            nextDist > TRACKER_SYSTEM_DEPARTURE_RADIUS
            || (nextDist >= 2_400 && radialDot > 0 && dtSeconds >= 10)
        ) {
            const alignedLink = findAlignedNeighbourLink(
                gameData,
                cached.systemId,
                systemData,
                dirX,
                dirY,
                0.5,
            ) ?? systemData?.links?.[0];
            if (alignedLink) {
                const distToExit = Math.max(0, 2_400 - Math.hypot(ship.position[0], ship.position[1]));
                const timeToExitMs = Math.min(elapsedMs, (distToExit / Math.max(1, cruiseSpeed)) * 1_000);
                const transfer: StorylineNpcTransfer = {
                    uuid: ship.uuid,
                    from: cached.systemId,
                    to: alignedLink,
                    departedAt: cached.savedAt + timeToExitMs,
                    departurePosition: [nextX, nextY],
                    ship: {
                        ...ship,
                        position: [nextX, nextY],
                        velocity: [dirX * cruiseSpeed, dirY * cruiseSpeed],
                        rotation: Math.atan2(dirX, -dirY),
                    },
                };
                departedTransfers.push(transfer);
                enqueueStorylineNpcTransfer(gameData, transfer);
            }
            // Ship has left the system and ceases to exist here
            continue;
        }

        ship.position = [nextX, nextY];
        ship.velocity = [dirX * cruiseSpeed, dirY * cruiseSpeed];
        ship.rotation = Math.atan2(dirX, -dirY);
        survivingShips.push(ship);
    }

    const naturalReplacements = Math.floor(elapsedMs / NATURAL_RESPAWN_CADENCE_MS);
    return {
        survivingShips,
        departedTransfers,
        naturalReplacements,
    };
}

function computeTransferEntryGeometry(
    source: readonly [number, number],
    destination: readonly [number, number],
    radius: number,
    speed: number,
    departurePosition?: readonly [number, number],
): { position: [number, number]; velocity: [number, number]; rotation: number } {
    const dx = destination[0] - source[0];
    const dy = destination[1] - source[1];
    const len = Math.hypot(dx, dy);
    const dirX = len > 0 ? dx / len : 0;
    const dirY = len > 0 ? dy / len : -1;
    const safeRadius = Math.max(0, radius);
    let offsetX = -dirX * safeRadius;
    let offsetY = -dirY * safeRadius;
    if (departurePosition && safeRadius > 0) {
        const perpX = -dirY;
        const perpY = dirX;
        const rawLateral = departurePosition[0] * perpX + departurePosition[1] * perpY;
        const maxLateral = safeRadius * 0.85;
        const lateral = Math.max(-maxLateral, Math.min(maxLateral, rawLateral));
        const longitudinal = -Math.sqrt(
            Math.max(0, safeRadius * safeRadius - lateral * lateral),
        );
        offsetX = dirX * longitudinal + perpX * lateral;
        offsetY = dirY * longitudinal + perpY * lateral;
    }
    const safeSpeed = Math.max(0, speed);
    const rotation = Math.atan2(dirX, -dirY);
    return {
        position: [offsetX, offsetY],
        velocity: [dirX * safeSpeed, dirY * safeSpeed],
        rotation,
    };
}

export function deadReckonTransferArrival(
    transfer: StorylineNpcTransfer,
    sourcePos: readonly [number, number],
    destPos: readonly [number, number],
    now = wallClockNow(),
): TransferArrivalPlacement {
    const arrivalSpeed = Math.max(60, transfer.ship.maxVelocity)
        * TRACKER_JUMP_ARRIVAL_SPEED_MULTIPLIER;
    const arrival = computeTransferEntryGeometry(
        sourcePos,
        destPos,
        TRACKER_JUMP_ARRIVAL_RADIUS,
        arrivalSpeed,
        transfer.departurePosition,
    );
    const elapsedMs = Math.max(0, now - transfer.departedAt);
    const rot = arrival.rotation;
    const dirX = Math.sin(rot);
    const dirY = -Math.cos(rot);

    if (elapsedMs <= 3_500) {
        return {
            position: [arrival.position[0], arrival.position[1]],
            velocity: [arrival.velocity[0], arrival.velocity[1]],
            rotation: rot,
            arriving: true,
            from: transfer.from,
            to: transfer.to,
        };
    }

    const cruiseSpeed = Math.max(60, transfer.ship.maxVelocity * 0.8);
    const travelSeconds = Math.min(35, (elapsedMs - 1_500) / 1_000);
    const travelDist = Math.min(
        TRACKER_JUMP_ARRIVAL_RADIUS * 1.5,
        cruiseSpeed * travelSeconds,
    );
    return {
        position: [
            arrival.position[0] + dirX * travelDist,
            arrival.position[1] + dirY * travelDist,
        ],
        velocity: [dirX * cruiseSpeed, dirY * cruiseSpeed],
        rotation: rot,
        arriving: false,
        from: transfer.from,
        to: transfer.to,
    };
}
