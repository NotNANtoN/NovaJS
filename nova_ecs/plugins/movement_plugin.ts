import * as t from 'io-ts';
import { Entities } from '../arg_types';
import { EntityMap } from '../entity_map';
import { Component } from '../component';
import { Angle, AngleType } from '../datatypes/angle';
import { Position, PositionType } from '../datatypes/position';
import { Vector, VectorLike, VectorType } from '../datatypes/vector';
import { Optional } from '../optional';
import { Plugin } from '../plugin';
import { System } from '../system';
import { applyObjectDelta } from './delta';
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
            before.position.x * inverse + after.position.x * amount,
            before.position.y * inverse + after.position.y * amount,
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
): MovementState {
    const advanced = copyMovementState(state);
    let remaining = Math.max(0, delta_s);
    while (remaining > 0) {
        const step = Math.min(remaining, 1 / 60);
        const time: Time = {
            time: 0,
            delta_s: step,
            delta_ms: step * 1000,
            frame: 0,
        };
        if (physics.movementType === MovementType.INERTIAL) {
            inertialControls(advanced, physics, time, entities);
        } else if (physics.movementType === MovementType.INERTIALESS) {
            inertialessControls(advanced, physics, time, entities);
        }
        remaining -= step;
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
        }
    } else if (state.turnBack) {
        if (state.velocity.length > 0) {
            let reverseAngle = state.velocity.angle.add(Math.PI);
            turnToAngle(state, physics, time, reverseAngle);
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
            deltaType: MovementState,
            getDelta(a, b) {
                // Omit position.
                // Send everything if a delta is detected.
                const same = a.turning === b.turning &&
                    a.accelerating === b.accelerating &&
                    a.turnTo === b.turnTo;

                if (same) {
                    return;
                }
                return b;
            },
            applyDelta: applyObjectDelta
        });

        deltaMaker.addComponent(MovementPhysicsComponent, {
            componentType: MovementPhysics
        });

        world.addComponent(MovementPhysicsComponent);
        world.addComponent(MovementStateComponent);
        world.addComponent(RemoteMovementPresentationComponent);
        world.addSystem(MovementSystem);
        world.addSystem(RemoteMovementPresentationSystem);
    }
};
