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

export const MovementState = t.intersection([t.type({
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
export type MovementState = t.TypeOf<typeof MovementState>;

export const MOVEMENT_POSITION_QUANTUM = 0.25;
export const MOVEMENT_VELOCITY_QUANTUM = 0.1;
export const MOVEMENT_ANGLE_QUANTUM = 0.001;

export const MovementStateDelta = t.partial({
    position: PositionType,
    velocity: VectorType,
    rotation: AngleType,
    turning: t.number,
    turnBack: t.boolean,
    accelerating: t.number,
    turnTo: t.union([AngleType, t.string, t.null]),
    targetSpeed: t.union([t.number, t.null]),
});
export type MovementStateDelta = t.TypeOf<typeof MovementStateDelta>;

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

function movementControlChanged(
    previous: MovementState,
    current: MovementState,
): boolean {
    return previous.turning !== current.turning
        || previous.turnBack !== current.turnBack
        || previous.accelerating !== current.accelerating
        || !sameAngle(previous.turnTo, current.turnTo)
        || previous.targetSpeed !== current.targetSpeed;
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
}

/**
 * Authoritative snapshots for non-owned entities. This component is local
 * presentation state; multiplayer never serializes it.
 */
export const RemoteMovementPresentationComponent =
    new Component<RemoteMovementPresentation>('RemoteMovementPresentation');

export interface GuidanceTargetTrack {
    snapshots: MovementSnapshot[];
}

export const GuidanceTargetTrackComponent =
    new Component<GuidanceTargetTrack>('GuidanceTargetTrack');

export const REMOTE_INTERPOLATION_DELAY_MS = 200;
export const REMOTE_MAX_EXTRAPOLATION_MS = 100;

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
    const inverse = 1 - amount;
    const rotationDelta = before.rotation.distanceTo(after.rotation).angle;
    const discrete = amount < 1 ? before : after;
    return {
        position: new Position(
            before.position.x + shortestWrappedDelta(
                before.position.x, after.position.x) * amount,
            before.position.y + shortestWrappedDelta(
                before.position.y, after.position.y) * amount,
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
    const presentation = targetEntity.components
        .get(RemoteMovementPresentationComponent);
    if (presentation?.snapshots.length) {
        return sampleRemoteMovement(presentation, atTime, physics, entities);
    }
    const track = targetEntity.components.get(GuidanceTargetTrackComponent);
    if (track?.snapshots.length) {
        return sampleRemoteMovement(track, atTime, physics, entities);
    }
    return movement ? copyMovementState(movement) : undefined;
}

export const MovementSystem = new System({
    name: 'movement',
    args: [MovementStateComponent, MovementPhysicsComponent,
        Optional(RemoteMovementPresentationComponent),
        TimeResource, Entities] as const,
    step(state, physics, presentation, time, entities) {
        if (presentation) {
            // Remote movement is sampled by the presentation system below.
            // Do not integrate it once and then overwrite it again.
            return;
        }
        if (physics.movementType === MovementType.INERTIAL) {
            inertialControls(state, physics, time, entities);
        } else if (physics.movementType === MovementType.INERTIALESS) {
            inertialessControls(state, physics, time, entities);
        }
    },
    after: [TimeSystem],
});

export const RemoteMovementPresentationSystem = new System({
    name: 'RemoteMovementPresentationSystem',
    args: [MovementStateComponent, MovementPhysicsComponent,
        RemoteMovementPresentationComponent, TimeResource, Entities] as const,
    step(state, physics, presentation, time, entities) {
        const renderTime = time.time - REMOTE_INTERPOLATION_DELAY_MS;
        const sampled = sampleRemoteMovement(
            presentation, renderTime, physics, entities);
        if (!sampled) {
            return;
        }
        state.position = sampled.position;
        state.velocity = sampled.velocity;
        state.rotation = sampled.rotation;
        state.turning = sampled.turning;
        state.turnBack = sampled.turnBack;
        state.accelerating = sampled.accelerating;
        state.turnTo = sampled.turnTo;
        state.targetSpeed = sampled.targetSpeed;

        // Keep one snapshot before the render cursor so the next frame can
        // continue interpolating across the same interval.
        while (presentation.snapshots.length > 2
            && presentation.snapshots[1].serverTime <= renderTime) {
            presentation.snapshots.shift();
        }
    },
    after: [MovementSystem],
});

function inertialControls(state: MovementState, physics: MovementPhysics,
    time: Time, entities: EntityMap) {
    handleTurning(state, physics, time, entities);

    // Acceleration
    if (state.accelerating > 0) {
        state.velocity = state.velocity.addInPlace(
            state.rotation.getUnitVector()
                .normalize(state.accelerating * physics.acceleration * time.delta_s));
    }
    state.velocity = state.velocity.shortenToLengthInPlace(physics.maxVelocity);

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

    const targetVelocity = state.rotation.getUnitVector().scale(state.targetSpeed);
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
        world.addSystem(MovementSystem);
        world.addSystem(RemoteMovementPresentationSystem);
    }
};
