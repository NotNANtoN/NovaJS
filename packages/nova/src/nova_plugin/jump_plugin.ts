import * as t from 'io-ts';
import { Emit, Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Angle } from "nova_ecs/datatypes/angle";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import { Entity } from "nova_ecs/entity";
import { EcsEvent } from "nova_ecs/events";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent, MovementSystem, MovementState, teleport } from "nova_ecs/plugins/movement_plugin";
import { Optional } from "nova_ecs/optional";
import { EncodedEntity, Serializer, SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Provide } from "nova_ecs/provide";
import { System } from "nova_ecs/system";
import { isLeft } from "fp-ts/lib/Either.js";
import { registerSimulationBridgeEvent } from "../communication/simulation_bridge_events.js";
import { deImmerify } from "../util/deimmerify.js";
import { FuelComponent, FUEL_PER_JUMP } from "./health_plugin.js";
import { ControlledByComponent, ShipControlEvent, ShipControlStateComponent } from "./ship_control.js";
import { ControlShipSystem } from "./ship_controller_plugin.js";
import { getShipMovementPhysics, ShipPhysicsComponent } from "./ship_plugin.js";
import { PlayerShipSelector } from "./player_ship_plugin.js";
import { SimulationGameDataResource } from "./game_data_resource.js";
import { PlayerSoundEvent } from "./sound_plugin.js";
import { SystemIdResource } from "./system_id_resource.js";

// Hyperspace jump tuning. The EVN Bible documents the *structure* of
// the jump sequence — ships must be outside the no-jump zone ("Jump
// Distance", 1000 pixels, adjusted by "hyperspace dist mod" outfits),
// they come to a stop unless they can "jump without slowing down"
// (shïp Flags2 0x0020 or a "fast jumping" outfit), turn to face the
// destination, and leave at a multiple of the normal hyperspace speed
// (shïp Flags 0x0001/0x0002/0x0004); arriving ships "jump in from
// hyperspace after a short delay". The three delay durations below are
// not numerically specified in the Bible; they are tuned to match the
// original game's feel.
/** Radius of the no-jump zone around the system center, in pixels. */
export const JUMP_DISTANCE = 1000;
/** Delay between finishing the turn toward the destination and the
 * hyperdrive engaging (thrust starting). */
export const JUMP_SPINUP_DELAY_MS = 1000;
/** How long a departing ship accelerates before it vanishes into
 * hyperspace. Acceleration is scaled so the ship reaches its full jump
 * speed exactly at departure. */
export const JUMP_DEPART_DELAY_MS = 2000;
/** How long an arriving ship takes to shed its hyperspace speed. The
 * player gets control back when it expires. */
export const JUMP_ARRIVAL_DELAY_MS = 1000;
/** The "normal" hyperspace jump speed, scaled per ship by the shïp
 * resource's jump speed flags (75% / 125% / 150%). An average ship's
 * top speed is 300. */
export const JUMP_BASE_SPEED = 1500;

/** How closely (radians) an inertial ship must face retrograde before
 * it thrusts to kill its velocity. */
const RETROGRADE_THRUST_TOLERANCE = 0.3;
const ALIGNED_TOLERANCE = 1e-9;

// The engine's hyperspace sounds live at fixed snd resource ids in the
// original game data: 128 "Warp up", 129 "Warp up.x2", 130 "Warp out".
// The EVN Bible does not document how the two warp-up variants are
// chosen; the ".x2" name indicates a double-speed variant of the same
// sound, so ships with an above-normal jump speed (the semi-fast/fast
// jumping shïp flags) play it here.
export const WARP_UP_SOUND = 'nova:128';
export const WARP_UP_FAST_SOUND = 'nova:129';
export const WARP_OUT_SOUND = 'nova:130';

export interface InitiateJump {
    to: string /* system uuid */,
}
export const InitiateJumpEvent = new EcsEvent<InitiateJump>('InitiateJumpEvent');

export type JumpRoute = {
    route: string[],
};
export const JumpRouteComponent = new Component<JumpRoute>('JumpRouteComponent');
const JumpRouteProvider = Provide({
    name: 'JumpRouteProvider',
    // Every controlled ship (any peer's), not just the local player:
    // this is shared simulation state.
    args: [ControlledByComponent] as const,
    provided: JumpRouteComponent,
    factory() {
        return { route: [] };
    }
});

/**
 * The hyperspace jump sequence state machine. Shared, deterministic
 * simulation state: every peer advances every jumping ship's sequence
 * identically. Registered with the serializer, so it crosses to the
 * destination system with the ship (stage 'arriving') and is included
 * in rollback snapshots via the default codec policy.
 */
export const JumpStateType = t.intersection([t.type({
    /** Destination system uuid. */
    to: t.string,
    stage: t.union([
        t.literal('stopping'),
        t.literal('aligning'),
        t.literal('spinup'),
        t.literal('accelerating'),
        t.literal('arriving'),
    ]),
    /** Travel heading (radians): the map-space direction from the
     * origin system to the destination system. */
    direction: t.number,
}), t.partial({
    /** Logical time (TimeResource ms) when the current timed stage
     * began. Unset for 'arriving' until the destination world's first
     * step, since logical time differs between systems. */
    stageStart: t.number,
})]);
export type JumpState = t.TypeOf<typeof JumpStateType>;
export const JumpComponent = new Component<JumpState>('JumpSequence');

export interface FinishJump {
    entity: Entity,
    uuid: string,
    to: string,
}
export const FinishJumpEvent = new EcsEvent<FinishJump>('FinishJumpEvent');

const EncodedFinishJumpEvent = t.type({
    entity: EncodedEntity,
    uuid: t.string,
    to: t.string,
});

export function FinishJumpEventType(serializer: Serializer) {
    return new t.Type<FinishJump, {
    entity: EncodedEntity,
    uuid: string,
    to: string,
    }>(
        'FinishJumpEventType',
        (_u): _u is FinishJump => true,
        (input, context) => {
            const encoded = EncodedFinishJumpEvent.validate(input, context);
            if (isLeft(encoded)) {
                return encoded;
            }
            const decoded = serializer.decode(encoded.right.entity);
            if (isLeft(decoded)) {
                return t.failure(
                    encoded.right.entity,
                    context,
                    serializer.describeDecodeFailure(encoded.right.entity, decoded.left),
                );
            }
            return t.success({
                entity: decoded.right,
                uuid: encoded.right.uuid,
                to: encoded.right.to,
            });
        },
        (data) => ({
            entity: serializer.encode(data.entity),
            uuid: data.uuid,
            to: data.to,
        }),
    );
}

registerSimulationBridgeEvent({
    event: FinishJumpEvent,
});

const JumpFromSystem = new System({
    name: 'JumpFromSystem',
    events: [InitiateJumpEvent],
    args: [GetEntity, UUID, Entities, InitiateJumpEvent, Emit] as const,
    step(entity, uuid, entities, { to }, emit) {
        entities.delete(uuid);
        deImmerify(entity);
        emit(FinishJumpEvent, { entity, uuid, to }, [uuid]);
    }
});

/**
 * Starts the jump sequence when a peer presses hyperjump: checks the
 * no-jump zone, resolves the travel heading from the systems' map
 * positions (staged at world genesis in makeSystem, so the cache read
 * is deterministic), and attaches the JumpComponent state machine.
 */
const PlayerJumpControl = new System({
    name: 'PlayerJumpControl',
    events: [ShipControlEvent],
    args: [ShipControlStateComponent, GetEntity, SystemIdResource,
        JumpRouteComponent, MovementStateComponent, ShipPhysicsComponent,
        FuelComponent, SimulationGameDataResource] as const,
    step(controlState, entity, systemId, jumpRoute, movement, shipPhysics,
        fuel, gameData) {
        if (controlState.get('hyperjump') !== 'start') {
            return;
        }
        if (entity.components.has(JumpComponent)) {
            // A jump is already in progress.
            return;
        }
        const destination = jumpRoute.route[0];
        if (!destination) {
            return;
        }
        // EVN Bible: ships can only enter hyperspace outside the
        // no-jump zone around the system center (standard radius 1000,
        // adjusted by "hyperspace dist mod" outfits).
        const jumpRadius = Math.max(0,
            JUMP_DISTANCE + shipPhysics.jumpDistanceMod);
        if (movement.position.length < jumpRadius) {
            return;
        }
        // EVN Bible: fuel "100 = 1 jump". Not enough fuel refuses the
        // jump the same way the no-jump zone does.
        if (fuel.current < FUEL_PER_JUMP) {
            return;
        }
        const origin = gameData.data.System.getCached(systemId);
        const dest = gameData.data.System.getCached(destination);
        if (!origin || !dest) {
            return;
        }
        const direction = new Vector(
            dest.position[0] - origin.position[0],
            dest.position[1] - origin.position[1]);
        jumpRoute.route.shift();
        entity.components.set(JumpComponent, {
            to: destination,
            // Ships with "fast jumping" skip coming to a stop.
            stage: shipPhysics.canJumpWithoutSlowing ? 'aligning' : 'stopping',
            direction: direction.length === 0 ? 0 : direction.angle.angle,
        });
    }
});

/** Overrides whatever the player's held controls just wrote: control
 * of the ship is taken away for the duration of the jump. */
function overrideControls(movement: MovementState) {
    movement.accelerating = 0;
    movement.turning = 0;
    movement.turnTo = null;
    movement.turnBack = false;
}

/**
 * Advances a jumping ship's state machine each tick. Runs after the
 * control systems (overriding player input) and before the movement
 * system. The physics the stages imply (the raised hyperspace speed
 * cap and burn acceleration) are applied by the afterburner plugin's
 * EffectiveMovementPhysicsSystem — the single per-tick writer of
 * effective movement physics — which orders itself after this system
 * and reads the jump stage.
 *
 * stopping -> aligning -> spinup -> accelerating happen in the origin
 * system; the ship then crosses to the destination system carrying
 * stage 'arriving'.
 */
export const JumpSequenceSystem = new System({
    name: 'JumpSequenceSystem',
    args: [JumpComponent, MovementStateComponent, ShipPhysicsComponent,
        Optional(FuelComponent), TimeResource, GetEntity, UUID,
        Emit] as const,
    step(jump, movement, shipPhysics, fuel, time, entity, uuid, emit) {
        overrideControls(movement);
        const jumpSpeed = JUMP_BASE_SPEED * shipPhysics.jumpSpeedMult;
        const target = new Angle(jump.direction);

        switch (jump.stage) {
            case 'stopping': {
                // Come to a complete stop before turning to the
                // destination (skipped for ships that can jump without
                // slowing down).
                const speed = movement.velocity.length;
                const stopThreshold =
                    shipPhysics.acceleration * time.delta_s * 2;
                if (speed <= stopThreshold) {
                    movement.velocity = new Vector(0, 0);
                    movement.targetSpeed = 0;
                    jump.stage = 'aligning';
                    break;
                }
                if (shipPhysics.inertialess) {
                    movement.accelerating = -1;
                } else {
                    // Turn retrograde and thrust once roughly aligned.
                    movement.turnBack = true;
                    const reverse = movement.velocity.angle.add(Math.PI);
                    const misalignment =
                        movement.rotation.distanceTo(reverse).angle;
                    if (Math.abs(misalignment) < RETROGRADE_THRUST_TOLERANCE) {
                        movement.accelerating = 1;
                    }
                }
                break;
            }
            case 'aligning': {
                movement.turnTo = target;
                const misalignment =
                    movement.rotation.distanceTo(target).angle;
                if (Math.abs(misalignment) < ALIGNED_TOLERANCE) {
                    movement.turnTo = null;
                    movement.rotation = target;
                    jump.stage = 'spinup';
                    jump.stageStart = time.time;
                }
                break;
            }
            case 'spinup': {
                // The hyperdrive charges while the ship holds still.
                movement.turnTo = target;
                if (time.time - (jump.stageStart ?? time.time)
                    >= JUMP_SPINUP_DELAY_MS) {
                    jump.stage = 'accelerating';
                    jump.stageStart = time.time;
                    // Sounds are display-side; emitting the event does
                    // not touch simulation state. Warp sounds are only
                    // heard by the jumping ship's own pilot: targeted
                    // at the ship, and the display plays them only for
                    // the local player's ship.
                    emit(PlayerSoundEvent, {
                        id: shipPhysics.jumpSpeedMult > 1
                            ? WARP_UP_FAST_SOUND : WARP_UP_SOUND,
                    }, [uuid]);
                }
                break;
            }
            case 'accelerating': {
                movement.turnTo = target;
                movement.accelerating = 1;
                // The raised speed cap and hyperdrive acceleration are
                // applied by EffectiveMovementPhysicsSystem (the single
                // per-tick writer of effective movement physics), which
                // runs after this system and reads the jump stage.
                if (time.time - (jump.stageStart ?? time.time)
                    >= JUMP_DEPART_DELAY_MS) {
                    // Depart. Set the arrival kinematics the destination
                    // system will see: the ship jumps in on the side of
                    // the system facing where it came from, at the edge
                    // of the no-jump zone, inbound at full jump speed.
                    const unit = target.getUnitVector();
                    teleport(movement,
                        new Position(-unit.x * JUMP_DISTANCE,
                            -unit.y * JUMP_DISTANCE),
                        unit.scale(jumpSpeed));
                    movement.rotation = target;
                    movement.targetSpeed = jumpSpeed;
                    jump.stage = 'arriving';
                    jump.stageStart = undefined;
                    // A jump costs FUEL_PER_JUMP (EVN Bible: fuel
                    // "100 = 1 jump"). The Bible doesn't say when the
                    // charge lands, so it is deducted at departure —
                    // the moment the ship actually leaves the system —
                    // and crosses to the destination with the entity.
                    if (fuel) {
                        fuel.current = Math.max(
                            fuel.min, fuel.current - FUEL_PER_JUMP);
                    }
                    emit(InitiateJumpEvent, { to: jump.to }, [uuid]);
                }
                break;
            }
            case 'arriving': {
                // Runs in the destination system: bleed off hyperspace
                // speed (EffectiveMovementPhysicsSystem ramps the speed
                // cap down from the jump stage), then hand control back.
                if (jump.stageStart === undefined) {
                    jump.stageStart = time.time;
                    emit(PlayerSoundEvent, { id: WARP_OUT_SOUND }, [uuid]);
                }
                const basePhysics = getShipMovementPhysics(shipPhysics);
                const progress =
                    (time.time - jump.stageStart) / JUMP_ARRIVAL_DELAY_MS;
                if (progress >= 1) {
                    if (movement.targetSpeed !== undefined) {
                        movement.targetSpeed = Math.min(
                            movement.targetSpeed, basePhysics.maxVelocity);
                    }
                    entity.components.delete(JumpComponent);
                }
                break;
            }
        }
    },
    after: [ControlShipSystem],
    before: [MovementSystem],
});

// For a single system to emit jump events.
export const JumpPlugin: Plugin = {
    name: 'JumpPlugin',
    build(world) {
        const serializer = world.resources.get(SerializerResource);
        serializer?.addComponent(JumpRouteComponent, t.type({
            route: t.array(t.string),
        }));
        serializer?.addComponent(JumpComponent, JumpStateType);
        if (serializer) {
            serializer.addEvent(FinishJumpEvent, FinishJumpEventType(serializer));
        }
        world.addSystem(JumpFromSystem);
        world.addSystem(PlayerJumpControl);
        world.addSystem(JumpSequenceSystem);
        world.addSystem(JumpRouteProvider);
    }
};
