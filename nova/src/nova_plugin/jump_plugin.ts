import * as t from "io-ts";
import { SystemData } from "novadatainterface/SystemData";
import { Emit, Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Angle } from "nova_ecs/datatypes/angle";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import { Entity } from "nova_ecs/entity";
import { EcsEvent } from "nova_ecs/events";
import { Plugin } from "nova_ecs/plugin";
import { Optional } from "nova_ecs/optional";
import { DeltaResource } from "nova_ecs/plugins/delta_plugin";
import {
    MovementPhysicsComponent,
    RemoteMovementPresentationComponent,
    MovementState,
    MovementStateComponent,
    MovementSystem,
} from "nova_ecs/plugins/movement_plugin";
import { replicationPolicies } from "nova_ecs/plugins/multiplayer_plugin";
import { TimeResource, wallClockNow } from "nova_ecs/plugins/time_plugin";
import { Provide } from "nova_ecs/provide";
import { System } from "nova_ecs/system";
import { deImmerify } from "../util/deimmerify";
import { ControlStateEvent } from "./control_state_event";
import { GameDataResource } from "./game_data_resource";
import { ArmorComponent } from "./health_plugin";
import { PlayerShipSelector } from "./player_ship_plugin";
import { advanceGameDate, PlayerStateComponent } from "./player_state";
import { canJump, spendJumpFuel } from "./fuel";
import { ShipDataComponent } from "./ship_plugin";
import { ControlPlayerShip } from "./ship_controller_plugin";
import { SoundEvent } from "./sound_event";
import { SystemIdResource } from "./system_id_resource";

export const JUMP_SPOOL_MS = 1_200;
export const JUMP_BAM_MS = 180;
export const JUMP_ARRIVAL_MS = 900;
export const JUMP_ARRIVAL_RADIUS = 1_400;
export const JUMP_DEPARTURE_SPEED_MULTIPLIER = 3.5;
export const JUMP_ARRIVAL_SPEED_MULTIPLIER = 3;
export const JUMP_ARRIVAL_END_SPEED_MULTIPLIER = 0.65;

export interface InitiateJump {
    to: string /* system uuid */,
}
export const InitiateJumpEvent = new EcsEvent<InitiateJump>('InitiateJumpEvent');

/** Raised when a jump the pilot asked for cannot happen. */
export interface JumpRefusal {
    reason: string;
}
export const JumpRefusedEvent =
    new EcsEvent<JumpRefusal>('JumpRefusedEvent');

const JumpRouteCodec = t.type({ route: t.array(t.string) });
export type JumpRoute = t.TypeOf<typeof JumpRouteCodec>;
export const JumpRouteComponent = new Component<JumpRoute>('JumpRouteComponent');
replicationPolicies.register(JumpRouteComponent, {
    codec: JumpRouteCodec,
    authority: 'owning-client',
});
const JumpRouteProvider = Provide({
    name: 'JumpRouteProvider',
    args: [PlayerShipSelector] as const,
    provided: JumpRouteComponent,
    factory() {
        return { route: [] };
    }
});

const JumpStateCodec = t.type({
    from: t.string,
    to: t.string,
    phase: t.union([
        t.literal('spooling'),
        t.literal('departing'),
        t.literal('arriving'),
    ]),
    phaseStartedAt: t.number,
    transitionAt: t.number,
    requiresAdjacency: t.boolean,
    arrivalSoundPending: t.boolean,
});
export type JumpState = t.TypeOf<typeof JumpStateCodec>;
export const JumpStateComponent = new Component<JumpState>(
    'JumpStateComponent');
replicationPolicies.register(JumpStateComponent, {
    codec: JumpStateCodec,
    authority: 'owning-client',
});

export type JumpTransition =
    | 'none'
    | 'begin-departure'
    | 'transfer'
    | 'finish-arrival';

export function pendingJumpTransition(
    state: Pick<JumpState, 'phase' | 'transitionAt'>,
    now: number,
): JumpTransition {
    if (now < state.transitionAt) {
        return 'none';
    }
    switch (state.phase) {
        case 'spooling':
            return 'begin-departure';
        case 'departing':
            return 'transfer';
        case 'arriving':
            return 'finish-arrival';
    }
}

export interface FinishJump {
    entity: Entity,
    uuid: string,
    from: string,
    to: string,
}
export const FinishJumpEvent = new EcsEvent<FinishJump>('FinishJumpEvent');

export interface JumpArrivalGeometry {
    position: Position;
    velocity: Vector;
    rotation: Angle;
}

/**
 * Enter on the side facing the source and travel toward the destination
 * system's center. Thus a destination east of the source enters from its west.
 */
export function calculateJumpArrival(
    source: readonly [number, number],
    destination: readonly [number, number],
    radius = JUMP_ARRIVAL_RADIUS,
    speed = 80,
): JumpArrivalGeometry {
    const delta = new Vector(
        destination[0] - source[0],
        destination[1] - source[1],
    );
    const direction = delta.lengthSquared > 0
        ? delta.normalize()
        : new Vector(0, -1);
    const offset = direction.scale(-Math.max(0, radius));
    return {
        position: new Position(offset.x, offset.y),
        velocity: direction.scale(Math.max(0, speed)),
        rotation: direction.angle,
    };
}

export function isValidNextHop(
    currentSystem: Pick<SystemData, 'links'> | undefined,
    nextSystem: string | undefined,
): nextSystem is string {
    return Boolean(nextSystem && currentSystem?.links.includes(nextSystem));
}

export function consumeCompletedHop(
    route: readonly string[],
    completedDestination: string,
): string[] {
    return route[0] === completedDestination
        ? route.slice(1)
        : [...route];
}

export function isCurrentRouteHop(
    route: readonly string[],
    destination: string,
): boolean {
    return route[0] === destination;
}

export function routeChangeCancelsJump(
    state: Pick<JumpState, 'phase' | 'requiresAdjacency' | 'to'>,
    route: readonly string[],
): boolean {
    return state.phase !== 'arriving'
        && state.requiresAdjacency
        && !isCurrentRouteHop(route, state.to);
}

export function restartJumpArrival(
    entity: Entity,
    now = wallClockNow(),
): void {
    const state = entity.components.get(JumpStateComponent);
    if (!state || state.phase !== 'arriving') {
        return;
    }
    state.phaseStartedAt = now;
    state.transitionAt = now + JUMP_ARRIVAL_MS;
    entity.components.delete(RemoteMovementPresentationComponent);
}

export function jumpFlightSpeed(
    phase: JumpState['phase'],
    elapsedMs: number,
    maxVelocity: number,
): number {
    const safeMax = Math.max(0, maxVelocity);
    if (phase === 'departing') {
        return safeMax * JUMP_DEPARTURE_SPEED_MULTIPLIER;
    }
    const duration = phase === 'spooling'
        ? JUMP_SPOOL_MS : JUMP_ARRIVAL_MS;
    const progress = Math.max(0, Math.min(1, elapsedMs / duration));
    if (phase === 'spooling') {
        // A quadratic ramp reads as a rapid launch without teleporting a
        // stationary ship to full hyperjump speed on the first frame.
        const eased = progress * progress;
        return safeMax * (
            0.45 + (JUMP_DEPARTURE_SPEED_MULTIPLIER - 0.45) * eased
        );
    }
    // Smoothly bleed the arrival boost down to an ordinary controllable speed.
    const eased = progress * progress * (3 - 2 * progress);
    return safeMax * (
        JUMP_ARRIVAL_SPEED_MULTIPLIER
        + (JUMP_ARRIVAL_END_SPEED_MULTIPLIER
            - JUMP_ARRIVAL_SPEED_MULTIPLIER) * eased
    );
}

export function applyJumpFlightMovement(
    movement: MovementState,
    direction: Vector,
    speed: number,
    deltaSeconds: number,
    showThrust: boolean,
): void {
    const velocity = direction.scale(Math.max(0, speed));
    // MovementSystem has already integrated this frame at its normal capped
    // velocity. Correct that integration to the bounded jump-flight velocity,
    // then publish the same velocity as authoritative world state.
    const correction = velocity.subtract(movement.velocity);
    movement.position = movement.position.addScaledInPlace(
        correction,
        Math.max(0, deltaSeconds),
    ) as Position;
    movement.velocity = velocity;
    movement.rotation = direction.angle;
    movement.turning = 0;
    movement.turnBack = false;
    movement.turnTo = direction.angle;
    movement.accelerating = showThrust ? 1 : 0;
    movement.targetSpeed = speed;
}

export function cancelJumpFlight(
    entity: Entity,
    movement: MovementState,
): void {
    entity.components.delete(JumpStateComponent);
    entity.components.delete(RemoteMovementPresentationComponent);
    movement.accelerating = 0;
    movement.turning = 0;
    movement.turnBack = false;
    movement.turnTo = null;
    if (movement.targetSpeed !== undefined) {
        movement.targetSpeed = Math.min(
            movement.targetSpeed,
            movement.velocity.length,
        );
    }
}

const PlayerJumpControl = new System({
    name: 'PlayerJumpControl',
    events: [ControlStateEvent],
    args: [ControlStateEvent, Emit, UUID, SystemIdResource, JumpRouteComponent,
        Optional(JumpStateComponent), Optional(ArmorComponent),
        GameDataResource, GetEntity, TimeResource,
        Optional(PlayerStateComponent), Optional(ShipDataComponent),
        PlayerShipSelector] as const,
    step(controlState, emit, uuid, systemId, jumpRoute, jumpState, armor,
        gameData, entity, time, playerState, shipData) {
        if (controlState.get('hyperjump') !== 'start' || jumpState
            || armor && armor.current <= 0) {
            return;
        }
        // A hull with no tank at all is not fuel limited; only refuse when
        // the ship has a tank and it cannot pay for the jump.
        if (playerState && (shipData?.fuelCapacity ?? 0) > 0
            && !canJump(playerState.fuel ?? 0)) {
            emit(JumpRefusedEvent, { reason: 'fuel' });
            emit(SoundEvent, { id: 'nova:153' });
            return;
        }
        const nextSystem = jumpRoute.route[0];
        const currentSystem = gameData.data.System.getCached(systemId);
        if (!isValidNextHop(currentSystem, nextSystem)) {
            if (nextSystem) {
                // A route whose first segment is no longer adjacent is stale.
                // Clear it deliberately instead of silently jumping elsewhere.
                jumpRoute.route = [];
                emit(SoundEvent, { id: 'nova:153' });
            }
            return;
        }
        const state: JumpState = {
            from: systemId,
            to: nextSystem,
            phase: 'spooling',
            phaseStartedAt: time.time,
            transitionAt: time.time + JUMP_SPOOL_MS,
            requiresAdjacency: true,
            arrivalSoundPending: false,
        };
        entity.components.set(JumpStateComponent, state);
        entity.components.delete(RemoteMovementPresentationComponent);
        emit(SoundEvent, { id: 'nova:128' });
    }
});

const InitiateJumpSystem = new System({
    name: 'InitiateJumpSystem',
    events: [InitiateJumpEvent],
    args: [
        InitiateJumpEvent,
        Optional(JumpStateComponent),
        Optional(ArmorComponent),
        SystemIdResource,
        TimeResource,
        GetEntity,
        Emit,
    ] as const,
    step({ to }, jumpState, armor, from, time, entity, emit) {
        if (jumpState || to === from || armor && armor.current <= 0) {
            return;
        }
        const state: JumpState = {
            from,
            to,
            phase: 'spooling',
            phaseStartedAt: time.time,
            transitionAt: time.time + JUMP_SPOOL_MS,
            requiresAdjacency: false,
            arrivalSoundPending: false,
        };
        entity.components.set(JumpStateComponent, state);
        entity.components.delete(RemoteMovementPresentationComponent);
        emit(SoundEvent, { id: 'nova:128' });
    },
});

const JumpLifecycleSystem = new System({
    name: 'JumpLifecycleSystem',
    after: [ControlPlayerShip, MovementSystem],
    args: [
        JumpStateComponent,
        MovementStateComponent,
        MovementPhysicsComponent,
        JumpRouteComponent,
        TimeResource,
        GameDataResource,
        Entities,
        GetEntity,
        UUID,
        Emit,
        Optional(PlayerStateComponent),
        Optional(ArmorComponent),
        PlayerShipSelector,
    ] as const,
    step(state, movement, physics, route, time, gameData, entities, entity,
        uuid, emit, playerState, armor) {
        if (armor && armor.current <= 0) {
            cancelJumpFlight(entity, movement);
            return;
        }

        const source = gameData.data.System.getCached(state.from);
        const destination = gameData.data.System.getCached(state.to);
        if (routeChangeCancelsJump(state, route.route)) {
            // An explicit route change while spooling cancels the old jump
            // without discarding the newly selected route.
            cancelJumpFlight(entity, movement);
            return;
        }
        if (!source || !destination
            || state.requiresAdjacency
            && !isValidNextHop(source, state.to)) {
            cancelJumpFlight(entity, movement);
            route.route = [];
            emit(SoundEvent, { id: 'nova:153' });
            return;
        }

        const direction = new Vector(
            destination.position[0] - source.position[0],
            destination.position[1] - source.position[1],
        );
        const travelDirection = direction.lengthSquared > 0
            ? direction.normalize()
            : new Vector(0, -1);

        if (state.phase === 'spooling') {
            if (pendingJumpTransition(state, time.time)
                === 'begin-departure') {
                state.phase = 'departing';
                state.phaseStartedAt = time.time;
                state.transitionAt = time.time + JUMP_BAM_MS;
                emit(SoundEvent, { id: 'nova:130' });
            }
            applyJumpFlightMovement(
                movement,
                travelDirection,
                jumpFlightSpeed(
                    state.phase,
                    time.time - state.phaseStartedAt,
                    physics.maxVelocity,
                ),
                time.delta_s,
                true,
            );
            return;
        }

        if (state.phase === 'departing') {
            applyJumpFlightMovement(
                movement,
                travelDirection,
                jumpFlightSpeed(
                    state.phase,
                    time.time - state.phaseStartedAt,
                    physics.maxVelocity,
                ),
                time.delta_s,
                true,
            );
            if (pendingJumpTransition(state, time.time) !== 'transfer') {
                return;
            }

            route.route = consumeCompletedHop(route.route, state.to);
            if (playerState) {
                if (state.requiresAdjacency) {
                    // Hypergates and mission jumps move the ship without
                    // spending the pilot's own fuel.
                    playerState.fuel = spendJumpFuel(playerState.fuel ?? 0);
                }
                advanceGameDate(playerState);
                playerState.currentSystem = state.to;
                if (!playerState.exploredSystems.includes(state.to)) {
                    playerState.exploredSystems.push(state.to);
                }
            }
            const arrival = calculateJumpArrival(
                source.position,
                destination.position,
                JUMP_ARRIVAL_RADIUS,
                physics.maxVelocity * JUMP_ARRIVAL_SPEED_MULTIPLIER,
            );
            movement.position = arrival.position;
            movement.velocity = arrival.velocity;
            movement.rotation = arrival.rotation;
            movement.turnTo = arrival.rotation;
            movement.accelerating = 0;
            state.phase = 'arriving';
            state.phaseStartedAt = time.time;
            state.transitionAt = time.time + JUMP_ARRIVAL_MS;
            state.arrivalSoundPending = true;
            entity.components.delete(RemoteMovementPresentationComponent);

            entities.delete(uuid);
            deImmerify(entity);
            emit(FinishJumpEvent, {
                entity,
                uuid,
                from: state.from,
                to: state.to,
            });
            return;
        }

        applyJumpFlightMovement(
            movement,
            travelDirection,
            jumpFlightSpeed(
                state.phase,
                time.time - state.phaseStartedAt,
                physics.maxVelocity,
            ),
            time.delta_s,
            false,
        );
        if (state.arrivalSoundPending) {
            state.arrivalSoundPending = false;
            emit(SoundEvent, { id: 'nova:302' });
        }
        if (pendingJumpTransition(state, time.time) === 'finish-arrival') {
            movement.turnTo = null;
            entity.components.delete(JumpStateComponent);
        }
    },
});

// For a single system to emit jump events.
export const JumpPlugin: Plugin = {
    name: 'JumpPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(JumpRouteComponent);
        world.addComponent(JumpStateComponent);
        deltaMaker.addComponent(JumpRouteComponent, {
            componentType: JumpRouteCodec,
        });
        deltaMaker.addComponent(JumpStateComponent, {
            componentType: JumpStateCodec,
        });
        world.addSystem(InitiateJumpSystem);
        world.addSystem(PlayerJumpControl);
        world.addSystem(JumpLifecycleSystem);
        world.addSystem(JumpRouteProvider);
    }
};

// // Pass jump events between systems.
// // TODO: Support changing set of systems.
// export const WorldJumpPlugin: Plugin = {
//     name: 'WorldJumpPlugin',
//     build(world) {
//         const systems = world.resources.get(SystemsResource);
//         if (!systems) {
//             throw new Error('World must have systems resource');
//         }

//         for (const [, system] of systems) {
//             system.events.get(FinishJumpEvent).subscribe(
//                 ({ entity, to, uuid }) => {
//                     const destination = systems.get(to) ?? system;
//                     destination.entities.set(uuid, entity);
//                 });
//         }
//     }
// }
