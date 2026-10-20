import * as t from 'io-ts';
import { Entities } from '../arg_types';
import { EntityMap } from '../entity_map';
import { Component } from '../component';
import { Angle, AngleType } from '../datatypes/angle';
import { BOUNDARY, Position, PositionType } from '../datatypes/position';
import { Vector, VectorLike, VectorType } from '../datatypes/vector';
import { Entity } from '../entity';
import { Optional } from '../optional';
import { Plugin } from '../plugin';
import { System } from '../system';
import { DeltaPlugin, DeltaResource } from './delta_plugin';
import { Time, TimeResource, TimeSystem } from './time_plugin';
import { DEFAULT_PRESENTATION_DELAY_MS, MAX_MOVEMENT_EXTRAPOLATION_MS, NetworkReceivePhase, NetworkTimingResource, PeerClock, AdvanceNetworkPlaybackSystem, MovementPlaybackComponent } from './network_timing';


export enum MovementType {
    INERTIAL = 0,
    INERTIALESS = 1,
    STATIONARY = 2,
}

export const MovementPhysics = t.type({
    maxVelocity: t.number,
    turnRate: t.number,
    acceleration: t.number,
    movementType: t.union([
        t.literal(MovementType.INERTIAL),
        t.literal(MovementType.INERTIALESS),
        t.literal(MovementType.STATIONARY)]),
});
export type MovementPhysics = t.TypeOf<typeof MovementPhysics>;

export const MovementPhysicsComponent = new Component<MovementPhysics>('MovementPhysics');

const MovementStateBase = t.intersection([t.type({
    position: PositionType,
    velocity: VectorType,
    rotation: AngleType,
    turning: t.number,
    turnBack: t.boolean,
    accelerating: t.number,
}), t.partial({
    turnTo: t.union([AngleType, t.string /* target UUID */, t.null]),
    targetSpeed: t.number,
})]);
export type MovementState = t.TypeOf<typeof MovementStateBase>;

export const MovementState = new t.Type<
    MovementState,
    t.OutputOf<typeof MovementStateBase>
>(
    'MovementState',
    MovementStateBase.is,
    (u, c) => {
        if (typeof u === 'object' && u !== null) {
            const raw = u as Record<string, any>;
            const pos = raw.position;
            const vel = raw.velocity;
            const rot = raw.rotation;
            if (
                typeof pos === 'object' && pos !== null
                && typeof pos.x === 'number' && typeof pos.y === 'number'
                && typeof vel === 'object' && vel !== null
                && typeof vel.x === 'number' && typeof vel.y === 'number'
                && typeof rot === 'object' && rot !== null
                && typeof rot.angle === 'number'
                && typeof raw.turning === 'number'
                && typeof raw.turnBack === 'boolean'
                && typeof raw.accelerating === 'number'
            ) {
                const rawTurnTo = raw.turnTo;
                let turnTo: Angle | string | null | undefined;
                let turnToValid = true;
                if (rawTurnTo === undefined || rawTurnTo === null || typeof rawTurnTo === 'string') {
                    turnTo = rawTurnTo;
                } else if (typeof rawTurnTo === 'object' && typeof rawTurnTo.angle === 'number') {
                    turnTo = new Angle(rawTurnTo.angle);
                } else {
                    turnToValid = false;
                }
                const rawTargetSpeed = raw.targetSpeed;
                const targetSpeedValid = rawTargetSpeed === undefined || typeof rawTargetSpeed === 'number';
                if (turnToValid && targetSpeedValid) {
                    const decoded: MovementState = {
                        position: new Position(pos.x, pos.y),
                        velocity: new Vector(vel.x, vel.y),
                        rotation: new Angle(rot.angle),
                        turning: raw.turning,
                        turnBack: raw.turnBack,
                        accelerating: raw.accelerating,
                    };
                    if (turnTo !== undefined) {
                        decoded.turnTo = turnTo;
                    }
                    if (rawTargetSpeed !== undefined) {
                        decoded.targetSpeed = rawTargetSpeed;
                    }
                    return t.success(decoded);
                }
            }
        }
        return MovementStateBase.validate(u, c);
    },
    (a) => {
        const out: Record<string, unknown> = {
            position: { x: a.position.x, y: a.position.y },
            velocity: { x: a.velocity.x, y: a.velocity.y },
            rotation: { angle: a.rotation.angle },
            turning: a.turning,
            turnBack: a.turnBack,
            accelerating: a.accelerating,
        };
        if ('turnTo' in a && a.turnTo !== undefined) {
            out.turnTo = a.turnTo instanceof Angle ? { angle: a.turnTo.angle } : a.turnTo;
        }
        if ('targetSpeed' in a && a.targetSpeed !== undefined) {
            out.targetSpeed = a.targetSpeed;
        }
        return out as t.OutputOf<typeof MovementStateBase>;
    },
);

export const MOVEMENT_POSITION_QUANTUM = 0.25;
export const MOVEMENT_VELOCITY_QUANTUM = 0.1;
export const MOVEMENT_ANGLE_QUANTUM = 0.001;

const MovementStateDeltaBase = t.partial({
    position: PositionType,
    velocity: VectorType,
    rotation: AngleType,
    turning: t.number,
    turnBack: t.boolean,
    accelerating: t.number,
    turnTo: t.union([AngleType, t.string, t.null]),
    targetSpeed: t.union([t.number, t.null]),
});
export type MovementStateDelta = t.TypeOf<typeof MovementStateDeltaBase>;

export const MovementStateDelta = new t.Type<
    MovementStateDelta,
    t.OutputOf<typeof MovementStateDeltaBase>
>(
    'MovementStateDelta',
    MovementStateDeltaBase.is,
    (u, c) => {
        if (typeof u === 'object' && u !== null && !Array.isArray(u)) {
            const raw = u as Record<string, any>;
            const out: MovementStateDelta = {};
            let fastOk = true;
            if (raw.position !== undefined) {
                if (typeof raw.position === 'object' && raw.position !== null
                    && typeof raw.position.x === 'number' && typeof raw.position.y === 'number') {
                    out.position = new Position(raw.position.x, raw.position.y);
                } else fastOk = false;
            }
            if (fastOk && raw.velocity !== undefined) {
                if (typeof raw.velocity === 'object' && raw.velocity !== null
                    && typeof raw.velocity.x === 'number' && typeof raw.velocity.y === 'number') {
                    out.velocity = new Vector(raw.velocity.x, raw.velocity.y);
                } else fastOk = false;
            }
            if (fastOk && raw.rotation !== undefined) {
                if (typeof raw.rotation === 'object' && raw.rotation !== null
                    && typeof raw.rotation.angle === 'number') {
                    out.rotation = new Angle(raw.rotation.angle);
                } else fastOk = false;
            }
            if (fastOk && raw.turning !== undefined) {
                if (typeof raw.turning === 'number') out.turning = raw.turning;
                else fastOk = false;
            }
            if (fastOk && raw.turnBack !== undefined) {
                if (typeof raw.turnBack === 'boolean') out.turnBack = raw.turnBack;
                else fastOk = false;
            }
            if (fastOk && raw.accelerating !== undefined) {
                if (typeof raw.accelerating === 'number') out.accelerating = raw.accelerating;
                else fastOk = false;
            }
            if (fastOk && raw.turnTo !== undefined) {
                if (raw.turnTo === null || typeof raw.turnTo === 'string') {
                    out.turnTo = raw.turnTo;
                } else if (typeof raw.turnTo === 'object' && typeof raw.turnTo.angle === 'number') {
                    out.turnTo = new Angle(raw.turnTo.angle);
                } else fastOk = false;
            }
            if (fastOk && raw.targetSpeed !== undefined) {
                if (raw.targetSpeed === null || typeof raw.targetSpeed === 'number') {
                    out.targetSpeed = raw.targetSpeed;
                } else fastOk = false;
            }
            if (fastOk) {
                return t.success(out);
            }
        }
        return MovementStateDeltaBase.validate(u, c);
    },
    (a) => {
        const out: Record<string, unknown> = {};
        if (a.position !== undefined) out.position = { x: a.position.x, y: a.position.y };
        if (a.velocity !== undefined) out.velocity = { x: a.velocity.x, y: a.velocity.y };
        if (a.rotation !== undefined) out.rotation = { angle: a.rotation.angle };
        if (a.turning !== undefined) out.turning = a.turning;
        if (a.turnBack !== undefined) out.turnBack = a.turnBack;
        if (a.accelerating !== undefined) out.accelerating = a.accelerating;
        if (a.turnTo !== undefined) {
            out.turnTo = a.turnTo instanceof Angle ? { angle: a.turnTo.angle } : a.turnTo;
        }
        if (a.targetSpeed !== undefined) out.targetSpeed = a.targetSpeed;
        return out as t.OutputOf<typeof MovementStateDeltaBase>;
    },
);

function roundToQuantum(value: number, quantum: number): number {
    const rounded = Math.round(value / quantum) * quantum;
    return rounded === 0 ? 0 : rounded;
}

export function quantizeMovementState(state: MovementState): MovementState {
    return {
        position: new Position(
            roundToQuantum(state.position.x, MOVEMENT_POSITION_QUANTUM),
            roundToQuantum(state.position.y, MOVEMENT_POSITION_QUANTUM),
        ),
        velocity: new Vector(
            roundToQuantum(state.velocity.x, MOVEMENT_VELOCITY_QUANTUM),
            roundToQuantum(state.velocity.y, MOVEMENT_VELOCITY_QUANTUM),
        ),
        rotation: new Angle(
            roundToQuantum(state.rotation.angle, MOVEMENT_ANGLE_QUANTUM)),
        turning: state.turning,
        turnBack: state.turnBack,
        accelerating: state.accelerating,
        turnTo: state.turnTo instanceof Angle
            ? new Angle(roundToQuantum(
                state.turnTo.angle, MOVEMENT_ANGLE_QUANTUM))
            : state.turnTo,
        targetSpeed: state.targetSpeed === undefined
            ? undefined
            : roundToQuantum(
                state.targetSpeed, MOVEMENT_VELOCITY_QUANTUM),
    };
}

function sameVector(
    a: VectorLike | undefined,
    b: VectorLike | undefined,
): boolean {
    return a?.x === b?.x && a?.y === b?.y;
}

function sameAngle(
    a: Angle | string | null | undefined,
    b: Angle | string | null | undefined,
): boolean {
    return a instanceof Angle && b instanceof Angle
        ? a.angle === b.angle
        : a === b;
}

export function quantizedMovementDelta(
    previous: MovementState,
    current: MovementState,
): MovementStateDelta | undefined {
    const a = quantizeMovementState(previous);
    const b = quantizeMovementState(current);
    const delta: MovementStateDelta = {};
    if (!sameVector(a.position, b.position)) {
        delta.position = b.position;
    }
    if (!sameVector(a.velocity, b.velocity)) {
        delta.velocity = b.velocity;
    }
    if (a.rotation.angle !== b.rotation.angle) {
        delta.rotation = b.rotation;
    }
    if (a.turning !== b.turning) {
        delta.turning = b.turning;
    }
    if (a.turnBack !== b.turnBack) {
        delta.turnBack = b.turnBack;
    }
    if (a.accelerating !== b.accelerating) {
        delta.accelerating = b.accelerating;
    }
    if (!sameAngle(a.turnTo, b.turnTo)) {
        delta.turnTo = b.turnTo ?? null;
    }
    if (a.targetSpeed !== b.targetSpeed) {
        delta.targetSpeed = b.targetSpeed ?? null;
    }
    return Object.keys(delta).length > 0 ? delta : undefined;
}

function turnToSignificantlyChanged(
    previous: MovementState,
    current: MovementState,
): boolean {
    if (sameAngle(previous.turnTo, current.turnTo)) {
        return false;
    }
    if (
        previous.turnTo instanceof Angle
        && current.turnTo instanceof Angle
        && previous.turning === current.turning
        && current.turning !== 0
    ) {
        return Math.abs(previous.turnTo.distanceTo(current.turnTo).angle) >= 0.08;
    }
    return true;
}

function movementControlChanged(
    previous: MovementState,
    current: MovementState,
): boolean {
    if (
        previous.turning !== current.turning
        || previous.turnBack !== current.turnBack
        || previous.accelerating !== current.accelerating
        || turnToSignificantlyChanged(previous, current)
        || previous.targetSpeed !== current.targetSpeed
    ) {
        return true;
    }
    // When an unaccelerated inertial entity (like floating ore under tractor pull
    // or a repositioned asteroid) has its velocity or position changed directly
    // by a system on the server, emit a movement delta so clients stay in sync.
    if (previous.accelerating === 0 && current.accelerating === 0) {
        const dvx = previous.velocity.x - current.velocity.x;
        const dvy = previous.velocity.y - current.velocity.y;
        if (dvx * dvx + dvy * dvy > MOVEMENT_VELOCITY_QUANTUM * MOVEMENT_VELOCITY_QUANTUM) {
            return true;
        }
    }
    const dx = shortestWrappedDelta(previous.position.x, current.position.x);
    const dy = shortestWrappedDelta(previous.position.y, current.position.y);
    return dx * dx + dy * dy > 120 * 120;
}

export function applyMovementStateDelta(
    state: MovementState,
    delta: MovementStateDelta,
): void {
    for (const [key, value] of Object.entries(delta)) {
        if (value === null && key === 'targetSpeed') {
            delete state.targetSpeed;
        } else {
            (state as unknown as Record<string, unknown>)[key] = value;
        }
    }
}

// Don't split this into separate position and velocity components
// because we don't want to send predictable deltas, such as when
// an entity is moving in a straight line. When an unpredictable event happens,
// such as when a player accelerates, we send the full state.
export const MovementStateComponent = new Component<MovementState>('MovementState');

export interface MovementSnapshot {
    readonly serverTime: number;
    readonly state: MovementState;
    readonly sequence?: number;
}

export interface RemoteMovementPresentation {
    snapshots: MovementSnapshot[];
    clock?: PeerClock;
    revision?: number;
    presentedRevision?: number;
    lastSample?: MovementState;
    lastRenderTime?: number;
    lastSourceRenderTime?: number;
    lastClockOffset?: number;
    generation?: number;
    positionCorrection?: Vector;
    rotationCorrection?: number;
}

/**
 * Authoritative snapshots for non-owned entities. This component is local
 * presentation state; multiplayer never serializes it.
 */
export const RemoteMovementPresentationComponent =
    new Component<RemoteMovementPresentation>('RemoteMovementPresentation');

export interface GuidanceTargetTrack {
    snapshots: MovementSnapshot[];
    clock?: PeerClock;
}

export const GuidanceTargetTrackComponent =
    new Component<GuidanceTargetTrack>('GuidanceTargetTrack');

/**
 * Replaces MovementSystem's own integration for one entity. Input prediction
 * uses this so the owning client and the server integrate that ship from the
 * same command stream. Local-only: never serialized.
 */
export interface MovementDriver {
    integrate(state: MovementState, physics: MovementPhysics, time: Time,
        entities: EntityMap): void;
}

export const MovementDriverComponent =
    new Component<MovementDriver>('MovementDriver');

export const REMOTE_INTERPOLATION_DELAY_MS = DEFAULT_PRESENTATION_DELAY_MS;
export const REMOTE_MAX_EXTRAPOLATION_MS = MAX_MOVEMENT_EXTRAPOLATION_MS;
const MOVEMENT_CORRECTION_HALF_LIFE_MS = 30;

export function copyMovementState(state: MovementState): MovementState {
    return {
        position: new Position(state.position.x, state.position.y),
        velocity: new Vector(state.velocity.x, state.velocity.y),
        rotation: new Angle(state.rotation.angle),
        turning: state.turning,
        turnBack: state.turnBack,
        accelerating: state.accelerating,
        turnTo: state.turnTo instanceof Angle
            ? new Angle(state.turnTo.angle)
            : state.turnTo,
        targetSpeed: state.targetSpeed,
    };
}

export function queueRemoteMovementSnapshot(
    presentation: RemoteMovementPresentation,
    state: MovementState,
    serverTime: number,
    sequence?: number,
): void {
    presentation.revision = (presentation.revision ?? 0) + 1;
    const snapshot = {
        state: copyMovementState(state),
        serverTime,
        sequence,
    };
    const existing = presentation.snapshots.findIndex(
        candidate => (sequence !== undefined
            && candidate.sequence === sequence)
            || candidate.serverTime === serverTime);
    if (existing >= 0) {
        presentation.snapshots[existing] = snapshot;
    } else {
        presentation.snapshots.push(snapshot);
    }
    presentation.snapshots.sort((a, b) => {
        if (a.sequence !== undefined && b.sequence !== undefined
            && a.sequence !== b.sequence) {
            return a.sequence - b.sequence;
        }
        return a.serverTime - b.serverTime;
    });
    // Reordered packets older than the retained interpolation window cannot
    // affect presentation and should not grow the component indefinitely.
    if (presentation.snapshots.length > 8) {
        presentation.snapshots.splice(0, presentation.snapshots.length - 8);
    }
}

export function queueGuidanceTargetSnapshot(
    track: GuidanceTargetTrack,
    state: MovementState,
    serverTime: number,
    sequence?: number,
): void {
    const snapshot = {
        state: copyMovementState(state),
        serverTime,
        sequence,
    };
    const last = track.snapshots.at(-1);
    if (!last || (serverTime > last.serverTime
        && (sequence === undefined || last.sequence === undefined
            || sequence > last.sequence))) {
        // Common in-order append (every frame for local recording): avoid
        // the sort/scan/filter below.
        track.snapshots.push(snapshot);
        let drop = 0;
        while (drop < track.snapshots.length - 1
            && track.snapshots[drop].serverTime <= serverTime - 4000) {
            drop++;
        }
        if (track.snapshots.length - drop > 64) {
            drop = track.snapshots.length - 64;
        }
        if (drop > 0) track.snapshots.splice(0, drop);
        return;
    }
    const existing = track.snapshots.findIndex(
        candidate => (sequence !== undefined
            && candidate.sequence === sequence)
            || candidate.serverTime === serverTime);
    if (existing >= 0) {
        track.snapshots[existing] = snapshot;
    } else {
        track.snapshots.push(snapshot);
    }
    track.snapshots.sort((a, b) => {
        if (a.sequence !== undefined && b.sequence !== undefined
            && a.sequence !== b.sequence) {
            return a.sequence - b.sequence;
        }
        return a.serverTime - b.serverTime;
    });
    const latestServerTime = Math.max(
        ...track.snapshots.map(snapshot => snapshot.serverTime));
    track.snapshots = track.snapshots.filter(snapshot =>
        snapshot.serverTime > latestServerTime - 4000);
    if (track.snapshots.length > 64) {
        track.snapshots.splice(0, track.snapshots.length - 64);
    }
}

const WORLD_PERIOD = BOUNDARY * 2;

function shortestWrappedDelta(from: number, to: number): number {
    let delta = to - from;
    if (delta > BOUNDARY) {
        delta -= WORLD_PERIOD;
    } else if (delta < -BOUNDARY) {
        delta += WORLD_PERIOD;
    }
    return delta;
}

function interpolateMovementState(
    before: MovementState,
    after: MovementState,
    amount: number,
): MovementState {
    const dx = shortestWrappedDelta(before.position.x, after.position.x);
    const dy = shortestWrappedDelta(before.position.y, after.position.y);
    // Do not interpolate a large teleport (such as off-screen asteroid recycling)
    // across the middle of the viewport.
    if (dx * dx + dy * dy > 900 * 900) {
        return copyMovementState(after);
    }
    const inverse = 1 - amount;
    const rotationDelta = before.rotation.distanceTo(after.rotation).angle;
    const discrete = amount < 1 ? before : after;
    return {
        position: new Position(
            before.position.x + dx * amount,
            before.position.y + dy * amount,
        ),
        velocity: new Vector(
            before.velocity.x * inverse + after.velocity.x * amount,
            before.velocity.y * inverse + after.velocity.y * amount,
        ),
        rotation: before.rotation.add(rotationDelta * amount),
        turning: discrete.turning,
        turnBack: discrete.turnBack,
        accelerating: discrete.accelerating,
        turnTo: discrete.turnTo,
        targetSpeed: before.targetSpeed === undefined
            || after.targetSpeed === undefined
            ? discrete.targetSpeed
            : before.targetSpeed * inverse + after.targetSpeed * amount,
    };
}

export function advanceMovementState(
    state: MovementState,
    physics: MovementPhysics,
    delta_s: number,
    entities: EntityMap,
    onStep?: (
        state: MovementState,
        stepSeconds: number,
        elapsedSeconds: number,
    ) => void,
): MovementState {
    const advanced = copyMovementState(state);
    let remaining = Math.max(0, delta_s);
    let elapsed = 0;
    while (remaining > 0) {
        const step = Math.min(remaining, 1 / 60);
        const time: Time = {
            time: 0,
            delta_s: step,
            delta_ms: step * 1000,
            frame: 0,
        };
        onStep?.(advanced, step, elapsed);
        if (physics.movementType === MovementType.INERTIAL) {
            inertialControls(advanced, physics, time, entities);
        } else if (physics.movementType === MovementType.INERTIALESS) {
            inertialessControls(advanced, physics, time, entities);
        }
        remaining -= step;
        elapsed += step;
    }
    return advanced;
}

export function sampleRemoteMovement(
    presentation: RemoteMovementPresentation,
    renderTime: number,
    physics: MovementPhysics,
    entities: EntityMap,
): MovementState | undefined {
    const snapshots = presentation.snapshots;
    // Buffers retain capture timestamps, so clock refinement cannot leave half
    // the history on an obsolete offset or collapse a relayed pose's age.
    renderTime -= presentation.clock?.offset ?? 0;
    if (snapshots.length === 0) {
        return;
    }
    const afterIndex = snapshots.findIndex(
        snapshot => snapshot.serverTime >= renderTime);
    if (afterIndex === 0) {
        return copyMovementState(snapshots[0].state);
    }
    if (afterIndex > 0) {
        const before = snapshots[afterIndex - 1];
        const after = snapshots[afterIndex];
        const span = after.serverTime - before.serverTime;
        const amount = span <= 0 ? 1
            : Math.max(0, Math.min(1,
                (renderTime - before.serverTime) / span));
        return interpolateMovementState(before.state, after.state, amount);
    }
    const latest = snapshots[snapshots.length - 1];
    const extrapolationMs = Math.min(
        REMOTE_MAX_EXTRAPOLATION_MS,
        Math.max(0, renderTime - latest.serverTime),
    );
    return advanceMovementState(
        latest.state, physics, extrapolationMs / 1000, entities);
}

export function sampleGuidanceTarget(
    targetEntity: Entity,
    atTime: number,
    entities: EntityMap,
): MovementState | undefined {
    const movement = targetEntity.components.get(MovementStateComponent);
    const physics = targetEntity.components.get(MovementPhysicsComponent)
        ?? {
            acceleration: 0,
            maxVelocity: Infinity,
            turnRate: 0,
            movementType: MovementType.INERTIAL,
        };
    // Guidance needs older history than the low-latency visual buffer retains.
    const track = targetEntity.components.get(GuidanceTargetTrackComponent);
    if (track?.snapshots.length) {
        return sampleRemoteMovement(track, atTime, physics, entities);
    }
    const presentation = targetEntity.components
        .get(RemoteMovementPresentationComponent);
    if (presentation?.snapshots.length) {
        return sampleRemoteMovement(presentation, atTime, physics, entities);
    }
    return movement ? copyMovementState(movement) : undefined;
}

export const MovementSystem = new System({
    name: 'movement',
    args: [MovementStateComponent, MovementPhysicsComponent,
        Optional(RemoteMovementPresentationComponent),
        TimeResource, Entities, Optional(MovementPlaybackComponent),
        Optional(MovementDriverComponent)] as const,
    step(state, physics, presentation, time, entities, playback, driver) {
        if (presentation) {
            // Remote movement is sampled by the presentation system below.
            // Do not integrate it once and then overwrite it again.
            return;
        }
        if (driver) {
            driver.integrate(state, physics, time, entities);
            return;
        }
        if (playback) {
            const dt_s = Math.max(0, playback.deltaMs / 1000);
            if (dt_s <= 1 / 30) {
                const playbackTime: Time = {
                    time: time.time,
                    delta_s: dt_s,
                    delta_ms: playback.deltaMs,
                    frame: time.frame,
                };
                if (physics.movementType === MovementType.INERTIAL) {
                    inertialControls(state, physics, playbackTime, entities);
                } else if (physics.movementType === MovementType.INERTIALESS) {
                    inertialessControls(state, physics, playbackTime, entities);
                }
            } else {
                Object.assign(state, advanceMovementState(state, physics, dt_s, entities));
            }
        } else if (physics.movementType === MovementType.INERTIAL) {
            inertialControls(state, physics, time, entities);
        } else if (physics.movementType === MovementType.INERTIALESS) {
            inertialessControls(state, physics, time, entities);
        }
    },
    after: [TimeSystem, NetworkReceivePhase, AdvanceNetworkPlaybackSystem],
});

export const RemoteMovementPresentationSystem = new System({
    name: 'RemoteMovementPresentationSystem',
    args: [MovementStateComponent, MovementPhysicsComponent,
        RemoteMovementPresentationComponent, TimeResource, Entities,
        Optional(NetworkTimingResource)] as const,
    step(state, physics, presentation, time, entities, network) {
        if (network && presentation.generation !== network.generation) {
            presentation.generation = network.generation;
            presentation.lastSample = undefined;
            presentation.lastRenderTime = presentation.lastSourceRenderTime = undefined;
            presentation.positionCorrection = undefined;
            presentation.rotationCorrection = 0;
        }
        const renderTime = network?.renderTime ?? time.time - REMOTE_INTERPOLATION_DELAY_MS;
        const offset = presentation.clock?.offset ?? 0;
        const localElapsed = Math.max(0, renderTime - (presentation.lastRenderTime ?? renderTime));
        const previousSourceTime = presentation.lastSourceRenderTime;
        const sourceRenderTime = previousSourceTime === undefined || localElapsed > 1000
            ? renderTime - offset
            : Math.max(previousSourceTime, Math.min(renderTime - offset,
                previousSourceTime + localElapsed * (presentation.clock?.rate ?? 1) * 1.1));
        const sampled = sampleRemoteMovement(
            presentation, sourceRenderTime + offset, physics, entities);
        if (!sampled) {
            return;
        }
        const elapsed = Math.max(0, sourceRenderTime - (presentation.lastSourceRenderTime ?? sourceRenderTime));
        const decay = Math.pow(0.5, elapsed / MOVEMENT_CORRECTION_HALF_LIFE_MS);
        const prevCorrection = presentation.positionCorrection ?? new Vector(0, 0);
        const prevRotCorrection = presentation.rotationCorrection ?? 0;
        let correction = prevCorrection.scale(decay);
        let rotationCorrection = prevRotCorrection * decay;
        if (presentation.lastSample && elapsed > 0 && elapsed < 250
            && (presentation.presentedRevision !== presentation.revision
                || presentation.lastClockOffset !== presentation.clock?.offset)) {
            const lastRendered = copyMovementState(presentation.lastSample);
            lastRendered.position = lastRendered.position.add(prevCorrection) as Position;
            lastRendered.rotation = lastRendered.rotation.add(prevRotCorrection);
            const expected = advanceMovementState(lastRendered, physics, elapsed / 1000, entities);
            const error = expected.position.subtract(sampled.position);
            if (error.lengthSquared < 256 * 256) {
                correction = error.scale(decay);
                rotationCorrection = sampled.rotation.distanceTo(expected.rotation).angle * decay;
            } else {
                // Teleports/room placement must not animate a long sweep.
                correction = new Vector(0, 0);
                rotationCorrection = 0;
            }
        }
        presentation.lastSample = copyMovementState(sampled);
        presentation.lastRenderTime = renderTime;
        presentation.lastSourceRenderTime = sourceRenderTime;
        presentation.lastClockOffset = presentation.clock?.offset;
        presentation.presentedRevision = presentation.revision;
        presentation.positionCorrection = correction;
        presentation.rotationCorrection = rotationCorrection;
        state.position = sampled.position.add(correction) as Position;
        state.velocity = sampled.velocity;
        state.rotation = sampled.rotation.add(rotationCorrection);
        if (network) {
            network.sampledEntities++;
            const latest = presentation.snapshots.at(-1);
            if (latest && sourceRenderTime > latest.serverTime) {
                network.extrapolatedEntities++;
            }
        }
        state.turning = sampled.turning;
        state.turnBack = sampled.turnBack;
        state.accelerating = sampled.accelerating;
        state.turnTo = sampled.turnTo;
        state.targetSpeed = sampled.targetSpeed;

        // Keep one snapshot before the render cursor so the next frame can
        // continue interpolating across the same interval.
        while (presentation.snapshots.length > 2
            && presentation.snapshots[1].serverTime <= sourceRenderTime) {
            presentation.snapshots.shift();
        }
    },
    after: [MovementSystem],
});

function inertialControls(state: MovementState, physics: MovementPhysics,
    time: Time, entities: EntityMap) {
    handleTurning(state, physics, time, entities);

    // Acceleration: scalar math avoids intermediate vector allocations
    if (state.accelerating > 0) {
        const theta = state.rotation.angle;
        const dV = state.accelerating * physics.acceleration * time.delta_s;
        const newVx = state.velocity.x + Math.sin(theta) * dV;
        const newVy = state.velocity.y - Math.cos(theta) * dV;
        const maxV = physics.maxVelocity;
        const speedSq = newVx * newVx + newVy * newVy;
        if (speedSq > maxV * maxV && maxV > 0) {
            const ratio = maxV / Math.sqrt(speedSq);
            state.velocity = new Vector(newVx * ratio, newVy * ratio);
        } else {
            state.velocity = new Vector(newVx, newVy);
        }
    } else {
        state.velocity = state.velocity.shortenToLengthInPlace(physics.maxVelocity);
    }

    // Velocity
    // TODO: Make it so you don't have to cast
    state.position = state.position
        .addScaledInPlace(state.velocity, time.delta_s) as Position;
}

function inertialessControls(state: MovementState, physics: MovementPhysics,
    time: Time, entities: EntityMap) {
    handleTurning(state, physics, time, entities);

    if (state.targetSpeed === undefined) {
        state.targetSpeed = state.velocity.length;
    }

    state.targetSpeed += state.accelerating * physics.acceleration * time.delta_s;
    state.targetSpeed = Math.min(state.targetSpeed, physics.maxVelocity);
    state.targetSpeed = Math.max(state.targetSpeed, 0);

    const theta = state.rotation.angle;
    const targetVelocity = new Vector(
        Math.sin(theta) * state.targetSpeed,
        -Math.cos(theta) * state.targetSpeed,
    );
    state.velocity = approachVec(targetVelocity, state.velocity,
        physics.acceleration * time.delta_s * 2);
    updatePosition(state, time);
}

function updatePosition(state: MovementState, time: Time) {
    state.position = state.position
        .addScaledInPlace(state.velocity, time.delta_s) as Position;
}
function handleTurning(state: MovementState, physics: MovementPhysics,
    time: Time, entities: EntityMap) {
    // Turning
    if (state.turnTo) {
        let angle: Angle | undefined;
        if (state.turnTo instanceof Angle) {
            angle = state.turnTo;
        } else {
            const otherPosition = entities.get(state.turnTo)
                ?.components.get(MovementStateComponent)?.position;
            if (otherPosition) {
                angle = otherPosition.subtract(state.position).angle;
            }
        }
        if (angle) {
            turnToAngle(state, physics, time, angle);
        } else {
            state.turning = 0;
        }
    } else if (state.turnBack) {
        if (state.velocity.length > 0) {
            let reverseAngle = state.velocity.angle.add(Math.PI);
            turnToAngle(state, physics, time, reverseAngle);
        } else {
            state.turning = 0;
        }
    }

    state.rotation = state.rotation
        .add(state.turning * physics.turnRate * time.delta_s);
}

export function approachVec<T extends Vector>(target: T, current: T, maxDelta: number): T {
    if (current.x === target.x && current.y === target.y) {
        return target;
    }
    const difference = target.subtract(current);
    if (difference.lengthSquared < maxDelta ** 1.2) {
        return target;
    }

    return current.addInPlace(difference.normalize().scale(maxDelta)) as T;
}

function turnToAngle(state: MovementState, physics: MovementPhysics,
    time: Time, target: Angle) {
    // Used for turning retrograde and pointing at a target
    let difference = state.rotation.distanceTo(target);

    // If we would turn past the target direction, just go to the target direction.
    if (physics.turnRate * time.delta_s > Math.abs(difference.angle)) {
        state.turning = 0;
        state.rotation = target;
    }
    else if (difference.angle > 0) {
        state.turning = 1;
    }
    else {
        state.turning = -1;
    }
}

export const MovementPlugin: Plugin = {
    name: 'MovementPlugin',
    build(world) {
        world.addPlugin(DeltaPlugin);
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }

        deltaMaker.addComponent(MovementStateComponent, {
            componentType: MovementState,
            deltaType: MovementStateDelta,
            snapshotValue: copyMovementState,
            isSnapshotDirty: movementControlChanged,
            getDelta(a, b) {
                return movementControlChanged(a, b)
                    ? quantizeMovementState(b)
                    : undefined;
            },
            applyDelta: applyMovementStateDelta,
        });

        deltaMaker.addComponent(MovementPhysicsComponent, {
            componentType: MovementPhysics
        });

        world.addComponent(MovementPhysicsComponent);
        world.addComponent(MovementStateComponent);
        world.addComponent(RemoteMovementPresentationComponent);
        world.addComponent(GuidanceTargetTrackComponent);
        world.addComponent(MovementDriverComponent);
        world.addSystem(AdvanceNetworkPlaybackSystem);
        world.addSystem(MovementSystem);
        world.addSystem(RemoteMovementPresentationSystem);
    }
};
