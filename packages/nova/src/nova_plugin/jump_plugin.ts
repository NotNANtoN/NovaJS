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
import { TimeResource, TimeSystem } from "nova_ecs/plugins/time_plugin";
import { Provide } from "nova_ecs/provide";
import { System } from "nova_ecs/system";
import { isLeft } from "fp-ts/lib/Either.js";
import { registerSimulationBridgeEvent } from "../communication/simulation_bridge_events.js";
import { deImmerify } from "../util/deimmerify.js";
import { DisabledComponent } from "./disabled_component.js";
import { FuelComponent, FUEL_PER_JUMP } from "./health_plugin.js";
import { ControlledByComponent, ShipControlStateComponent } from "./ship_control.js";
import { ControlShipSystem } from "./ship_controller_plugin.js";
import { ShipPhysics } from "novadatainterface/ship_data";
import { getShipMovementPhysics, ShipPhysicsComponent } from "./ship_plugin.js";
import { PlayerShipSelector } from "./player_ship_plugin.js";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
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
/** The "normal" hyperspace jump speed, scaled per ship by the shïp
 * resource's jump speed flags (75% / 125% / 150%). */
export const JUMP_BASE_SPEED = 1500;
/** Ships jump in this many seconds of flight (at their regular top
 * speed) outside the no-jump radius. They arrive coasting inward at
 * that speed, so the margin is the time a pilot has to start another
 * jump before drifting inside the no-jump zone — a held jump key only
 * needs one tick, and three seconds is comfortable for a human. */
export const JUMP_ARRIVAL_MARGIN_S = 3;

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

function warpUpSound(shipPhysics: { jumpSpeedMult: number }) {
    return shipPhysics.jumpSpeedMult > 1
        ? WARP_UP_FAST_SOUND : WARP_UP_SOUND;
}

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
     * (spinup, accelerating) began. Cleared at departure: logical time
     * differs between systems. */
    stageStart: t.number,
    /**
     * How many further jumps to auto-continue along the route without the
     * player re-pressing the jump key ("multi-jump" outfits, ModType 32). Set
     * when the player first initiates a jump to min(multiJump, route length),
     * decremented on each auto-continued jump, and carried across systems with
     * the entity. Absent/0 means the ship stops after this jump. */
    autoJumpsLeft: t.number,
})]);
export type JumpState = t.TypeOf<typeof JumpStateType>;
export const JumpComponent = new Component<JumpState>('JumpSequence');

/**
 * Marker left on a ship that just arrived from a jump and still has
 * "multi-jump" budget (ModType 32), telling MultiJumpContinueSystem to start
 * the route's next jump this tick without a fresh key press. `left` is the
 * remaining auto-jump budget, passed on to the next JumpComponent. Transient
 * sim state: cloned in snapshots (see snapshot_policies) so a rollback across
 * an arrival tick still auto-continues.
 */
export const MultiJumpContinueComponent =
    new Component<{ left: number }>('MultiJumpContinue');

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

/**
 * Exported so EscortFollowJumpSystem (player_escort_plugin) can order
 * itself BEFORE the departing ship is deleted and its FinishJumpEvent
 * emitted: the escorts' carry events must reach the client's frame event
 * list ahead of the jump the client follows.
 */
export const JumpFromSystem = new System({
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
 * Attaches a JumpComponent for a jump to `destination`, resolving the travel
 * heading from the origin and destination systems' map positions. Shifts the
 * destination off the route. Returns false (and does nothing) if the system
 * data is not yet cached. `autoJumpsLeft` is the remaining multi-jump budget
 * to carry into this jump.
 *
 * Both getCached reads are provably warm (the staging contract for in-sim
 * getCached): `systemId` is this world's own system, and `destination` is
 * always route[0] — the next hop. A route is a Dijkstra path over
 * system.links (starmap.computeShortestPaths), so every consecutive pair is
 * adjacent; route[0] is therefore a *link* of this world's system, and
 * makeSystem stages every linked system's data at genesis (make_system.ts).
 * This holds at every hop of a multi-jump chain: each per-system world is
 * built through makeSystem on every peer (browser worker, server archive,
 * node worker), so the link set is warm before the world steps.
 */
function beginJump(entity: Entity, systemId: string, destination: string,
    jumpRoute: JumpRoute, shipPhysics: ShipPhysics,
    gameData: SimulationGameDataInterface, autoJumpsLeft: number): boolean {
    const origin = gameData.data.System.getCached(systemId);
    const dest = gameData.data.System.getCached(destination);
    if (!origin || !dest) {
        return false;
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
        autoJumpsLeft,
    });
    return true;
}

/**
 * Starts the jump sequence while a peer holds hyperjump: checks the
 * no-jump zone, resolves the travel heading from the systems' map
 * positions (staged at world genesis in makeSystem, so the cache read
 * is deterministic), and attaches the JumpComponent state machine.
 *
 * Polled every tick rather than edge-triggered so that *holding* the
 * jump key departs at the first instant a jump becomes possible —
 * flying out of the no-jump zone with the key held, or chain-jumping:
 * ships arrive outside the no-jump radius, so a held key starts the
 * route's next jump immediately.
 */
const PlayerJumpControl = new System({
    name: 'PlayerJumpControl',
    args: [ShipControlStateComponent, GetEntity, SystemIdResource,
        JumpRouteComponent, MovementStateComponent, ShipPhysicsComponent,
        FuelComponent, SimulationGameDataResource,
        Optional(DisabledComponent)] as const,
    step(controlState, entity, systemId, jumpRoute, movement, shipPhysics,
        fuel, gameData, disabled) {
        // Truthy while held ('start'/'repeat'/true); false on release.
        if (!controlState.get('hyperjump')) {
            return;
        }
        // A disabled ship cannot spin up its hyperdrive (it cannot even
        // thrust; see disabled_component.ts).
        if (disabled) {
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
        // "multi-jump" (ModType 32): a single jump initiation performs up to
        // multiJump EXTRA jumps along the route automatically. Budget the
        // auto-continues to what the remaining route can actually reach (after
        // this jump's own destination is shifted off).
        const autoJumpsLeft = Math.max(0,
            Math.min(shipPhysics.multiJump, jumpRoute.route.length - 1));
        beginJump(entity, systemId, destination, jumpRoute, shipPhysics,
            gameData, autoJumpsLeft);
    }
});

/**
 * Auto-continues a multi-jump (ModType 32) route the tick after a ship arrives
 * from hyperspace: if it left a MultiJumpContinueComponent marker and still
 * has a routed destination and enough fuel, it starts the next jump without a
 * fresh key press (the ship arrives outside the no-jump zone, so no radius
 * check is needed). Runs before PlayerJumpControl so a released key never
 * cancels an in-flight multi-jump chain.
 */
const MultiJumpContinueSystem = new System({
    name: 'MultiJumpContinueSystem',
    args: [MultiJumpContinueComponent, GetEntity, SystemIdResource,
        JumpRouteComponent, ShipPhysicsComponent, FuelComponent,
        SimulationGameDataResource] as const,
    step(cont, entity, systemId, jumpRoute, shipPhysics, fuel, gameData) {
        // Consume the marker regardless of outcome, so a blocked continuation
        // (no route / no fuel) simply ends the chain.
        entity.components.delete(MultiJumpContinueComponent);
        if (entity.components.has(JumpComponent)) {
            return;
        }
        const destination = jumpRoute.route[0];
        if (!destination || cont.left <= 0) {
            return;
        }
        if (fuel.current < FUEL_PER_JUMP) {
            return;
        }
        beginJump(entity, systemId, destination, jumpRoute, shipPhysics,
            gameData, cont.left - 1);
    },
    before: [PlayerJumpControl],
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
        Optional(FuelComponent), Optional(JumpRouteComponent), TimeResource,
        GetEntity, UUID, Emit] as const,
    step(jump, movement, shipPhysics, fuel, jumpRoute, time, entity, uuid,
        emit) {
        overrideControls(movement);
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
                    // The warp-up sound starts the moment the ship is
                    // ready to jump: stopped (for ships that must
                    // stop) and pointing at the destination. Sounds
                    // are display-side; emitting the event does not
                    // touch simulation state. Warp sounds are only
                    // heard by the jumping ship's own pilot: targeted
                    // at the ship, and the display plays them only for
                    // the local player's ship.
                    emit(PlayerSoundEvent, {
                        id: warpUpSound(shipPhysics),
                    }, [uuid]);
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
                    // the system facing where it came from, coasting
                    // inward at its regular top speed, far enough
                    // outside the no-jump zone (JUMP_ARRIVAL_MARGIN_S)
                    // that another jump can start before it drifts in.
                    const basePhysics = getShipMovementPhysics(shipPhysics);
                    const jumpRadius = Math.max(0,
                        JUMP_DISTANCE + shipPhysics.jumpDistanceMod);
                    const arrivalDistance = jumpRadius
                        + basePhysics.maxVelocity * JUMP_ARRIVAL_MARGIN_S;
                    const unit = target.getUnitVector();
                    teleport(movement,
                        new Position(-unit.x * arrivalDistance,
                            -unit.y * arrivalDistance),
                        unit.scale(basePhysics.maxVelocity));
                    movement.rotation = target;
                    movement.targetSpeed = basePhysics.maxVelocity;
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
                // The first tick in the destination system. The ship
                // arrives already at its regular top speed, so there is
                // no hyperspace speed to bleed off: clip the warp-up
                // (it must not ring out over the new system), play the
                // warp-out, and hand control straight back — a held
                // jump key can start the route's next jump on the very
                // next tick.
                emit(PlayerSoundEvent,
                    { id: warpUpSound(shipPhysics), stop: true }, [uuid]);
                emit(PlayerSoundEvent, { id: WARP_OUT_SOUND }, [uuid]);
                entity.components.delete(JumpComponent);
                // "multi-jump" (ModType 32): if the ship still has auto-jump
                // budget, leave a marker so MultiJumpContinueSystem starts the
                // route's next jump this tick without the player re-pressing
                // the key. The marker carries the remaining budget across to
                // the fresh JumpComponent.
                if ((jump.autoJumpsLeft ?? 0) > 0) {
                    entity.components.set(MultiJumpContinueComponent,
                        { left: jump.autoJumpsLeft! });
                } else {
                    entity.components.delete(MultiJumpContinueComponent);
                }
                break;
            }
        }
    },
    // Determinism rule 4: this stage machine reads time.time/time.delta_s
    // to advance its timed stages, so it must run after TimeSystem. The
    // after: [ControlShipSystem] edge does NOT imply this (ControlShipSystem
    // is not itself ordered after TimeSystem), so without the explicit edge a
    // restore could toposort JumpSequenceSystem before TimeSystem.
    after: [TimeSystem, ControlShipSystem],
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
        // The multi-jump continuation marker crosses systems with the entity
        // (it is set in the origin world at departure and read in the
        // destination world), so it must serialize.
        serializer?.addComponent(MultiJumpContinueComponent,
            t.type({ left: t.number }));
        if (serializer) {
            serializer.addEvent(FinishJumpEvent, FinishJumpEventType(serializer));
        }
        world.addSystem(JumpFromSystem);
        world.addSystem(MultiJumpContinueSystem);
        world.addSystem(PlayerJumpControl);
        world.addSystem(JumpSequenceSystem);
        world.addSystem(JumpRouteProvider);
    }
};
