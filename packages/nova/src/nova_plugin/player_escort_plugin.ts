import { isLeft } from 'fp-ts/lib/Either.js';
import * as t from 'io-ts';
import { Emit, Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { EcsEvent } from 'nova_ecs/events';
import { Plugin } from 'nova_ecs/plugin';
import {
    MovementState, MovementStateComponent, MovementSystem,
} from 'nova_ecs/plugins/movement_plugin';
import {
    EncodedEntity, Serializer, SerializerResource,
} from 'nova_ecs/plugins/serializer_plugin';
import { TimeResource, TimeSystem } from 'nova_ecs/plugins/time_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { registerSimulationBridgeEvent } from '../communication/simulation_bridge_events.js';
import { deImmerify } from '../util/deimmerify.js';
import { CollectableEscortComponent, ReturnComponent } from './bay_plugin.js';
import { EscortCommandComponent } from './escort_command.js';
import { FiringGroupComponent } from './firing_group.js';
import { flockParent, MAX_FLOCK_DEPTH } from './flock.js';
import { FuelComponent } from './health_plugin.js';
import { InitiateJumpEvent, JumpFromSystem } from './jump_plugin.js';
import { MissionShipComponent } from './mission_ship_plugin.js';
import {
    formationsIn, FormationComponent, FormationSystem, nextFormationSlot,
    RCS_ACCEL_FRACTION,
} from './npc_ai_plugin.js';
import { LandEvent, PlanetDataComponent } from './planet_plugin.js';
import {
    EscortLanding, EscortLandingComponent, PlayerEscort, PlayerEscortComponent,
} from './player_escort.js';
import { ControlledByComponent } from './ship_control.js';
import { ShipComponent, ShipPhysicsComponent } from './ship_plugin.js';

/**
 * ============================================================================
 * Player escorts follow the player's lifecycle
 * ============================================================================
 *
 * Escorts (hired escorts, captured hulks, and fighters launched from the
 * player's bays) used to be strictly in-system, in-flight entities: the
 * player landing removed their leader from the simulation and orphaned
 * them, and jumping left them behind entirely. This module makes them
 * follow the player instead:
 *
 *  - OWNERSHIP is durable. MarkPlayerEscortsSystem stamps
 *    PlayerEscortComponent on every ship whose escort chain tops out at a
 *    player-controlled ship, and nothing here ever clears it because the
 *    player went missing. FormationSystem's leader-gone rule is
 *    deliberately UNCHANGED (see the note on EscortReattachSystem): the
 *    formation link is allowed to lapse while the player is away and is
 *    rebuilt on return, so genuinely-released NPC followers keep behaving
 *    exactly as before.
 *
 *  - LANDING. The player's LandEvent orders their escorts to the same
 *    stellar (EscortLandOrderSystem). Each escort flies there
 *    (EscortLandingSystem) and, inside a relaxed landing window, is
 *    removed from the simulation and handed to the owning client as a
 *    fully serialized entity via EscortLandedEvent — the same split
 *    landing itself uses (deterministic despawn in the sim; the per-player
 *    roster lives client-side, see spaceport/landed_escorts.ts). Other
 *    peers simply watch the escorts land.
 *
 *  - DEPARTURE. The client respawns the roster alongside the relaunched
 *    player (browser.ts). Escorts that never made it to the planet are
 *    re-attached by EscortReattachSystem the moment the player's entity is
 *    back in the world, so ownership survives a landing even when an
 *    escort was still mid-approach.
 *
 *  - JUMPING. EscortFollowJumpSystem serializes the player's escorts out
 *    of the origin system as the player departs and hands them to the
 *    client, which inserts them at formation stations around the player's
 *    arrival point in the destination system. Their jumps are FREE (no
 *    fuel deduction): an escort must always be able to follow. The one
 *    exception is a ship with no energy capacity at all (shïp "energy" 0,
 *    i.e. FuelComponent.max === 0) — it has no hyperdrive, so it stays
 *    behind, still owned, and is only recovered if the player comes back.
 *
 * COMMAND RESET. Escorts used to reset to the 'formation' command purely
 * by accident (they were rebuilt from scratch at every boundary). Now
 * that they persist, the reset is explicit at both boundaries: the client
 * stamps 'formation' on every escort it inserts (jump arrival and
 * liftoff), and EscortReattachSystem stamps it on every escort it
 * re-attaches.
 *
 * DOCUMENTED SEAMS (deliberate v1 limits):
 *  - No warp animation for a following escort. They are carried instantly
 *    and simply appear at their station beside the arriving player, rather
 *    than each playing the departure/arrival sequence. Giving them a real
 *    sequence means running JumpComponent state machines on non-player
 *    ships and delaying the carry until each finishes.
 *  - Gate transit (hypergates and wormholes) does not carry escorts that
 *    are still FLYING. Gate departures run through GateDepartureSystem /
 *    GateTransitEvent rather than InitiateJumpEvent, so those escorts are
 *    left in the origin system, still owned, and landing at a gate issues
 *    no landing orders. Two related cases DO work: docking at a hypergate
 *    and lifting back off (the player's entity returns under the same uuid,
 *    so EscortReattachSystem picks the escorts back up), and a transit made
 *    while already holding a landed roster (the client carries that roster
 *    to the destination rather than dropping it).
 *  - A "multi-jump" outfit chain (ModType 32) can out-run the carry: the
 *    escorts are re-inserted through an input record, so if the player
 *    auto-continues the next jump before that record lands, the escorts
 *    are left in the intermediate system.
 *  - Escorts are not saved (see save_game.ts).
 */

// --- Tuning constants ---

/**
 * The landing window for an AI-steered escort, deliberately looser than
 * the player's (planet_plugin's LAND_DISTANCE_SQUARED = 10_000 / 100px
 * and LAND_SPEED_SQUARED = 3_000 / ~55px per second). The player nudges
 * their ship into a 100px bullseye by hand; an escort arrives under a
 * proportional-approach controller whose final convergence is bounded by
 * its RCS budget, so a heavy, low-acceleration hulk can hover just
 * outside the strict window for a long time. 300px / 100px per second
 * lands every stock hull promptly and is still visually "at the planet".
 */
export const ESCORT_LAND_DISTANCE_SQUARED = 90_000;
export const ESCORT_LAND_SPEED_SQUARED = 10_000;

/**
 * Approach gain (1/s) for the landing controller: the escort aims for a
 * speed of gain * remaining distance, capped at its top speed. This is
 * the standard "arrival" profile — it decelerates automatically as the
 * stellar gets closer instead of overshooting and orbiting.
 */
export const ESCORT_APPROACH_GAIN = 1.2;

/**
 * Correction magnitude (px/s) below which the landing controller switches
 * from turn-and-burn to a direct RCS-style velocity nudge, exactly like
 * formation station-keeping (steerFormation): the last few px/s of an
 * approach cannot be bled off with the main engine without the ship
 * spinning in place.
 */
export const ESCORT_APPROACH_RCS_SPEED = 60;

/**
 * The player ship at the top of `uuid`'s escort chain, plus the escort's
 * immediate leader. Walks the same chain isInFlock does (formation leader
 * -> bay owner -> firing group) and stops at the first ancestor that is a
 * player-controlled ship. Returns undefined when the chain reaches no
 * such ship — including the important case where the player's entity is
 * simply not in the world right now (landed or jumping), which is why
 * callers must treat undefined as "no new information" rather than "not
 * owned".
 */
export function playerEscortLink(uuid: string,
    getEntity: (uuid: string) => Entity | undefined):
    PlayerEscort | undefined {
    const self = getEntity(uuid);
    if (!self) {
        return undefined;
    }
    const parent = flockParent(self);
    if (parent === undefined || parent === uuid) {
        return undefined;
    }
    const visited = new Set<string>([uuid]);
    let current = parent;
    for (let depth = 0; depth < MAX_FLOCK_DEPTH; depth++) {
        if (visited.has(current)) {
            return undefined; // Leader cycle: nobody's escort.
        }
        visited.add(current);
        const entity = getEntity(current);
        if (!entity) {
            return undefined; // The chain ends at a ship that isn't here.
        }
        if (entity.components.has(ControlledByComponent)) {
            return { player: current, parent };
        }
        const next = flockParent(entity);
        if (next === undefined) {
            return undefined;
        }
        current = next;
    }
    return undefined;
}

/**
 * Steers a ship to come to rest at `target` (a stellar's position).
 * Proportional arrival profile plus the same two-regime hysteresis-free
 * split formation keeping uses: turn-and-burn while the velocity
 * correction is large, a budgeted RCS nudge once it is small. Pure, so
 * convergence is unit-testable.
 */
export function steerToStellar(movement: MovementState, target: Position,
    acceleration: number, maxVelocity: number, delta_s: number): void {
    // Position subtraction yields the shortest toroidal delta.
    const error = target.subtract(movement.position);
    const distance = error.length;
    const desiredSpeed = Math.min(maxVelocity,
        distance * ESCORT_APPROACH_GAIN);
    const desired = distance > 1e-9
        ? error.normalize(desiredSpeed) : new Vector(0, 0);
    const correction = desired.subtract(
        Vector.fromVectorLike(movement.velocity));
    const magnitude = correction.length;
    const budget = acceleration * RCS_ACCEL_FRACTION * delta_s;
    if (magnitude < Math.max(budget, ESCORT_APPROACH_RCS_SPEED)) {
        const nudge = magnitude <= budget
            ? correction : correction.normalize(budget);
        movement.velocity = Vector.fromVectorLike(movement.velocity)
            .add(nudge);
        movement.accelerating = 0;
        movement.turnBack = false;
        movement.turnTo = distance > 1e-9 ? error.angle : null;
        return;
    }
    const heading = correction.angle;
    movement.turnTo = heading;
    movement.turnBack = false;
    movement.accelerating =
        Math.abs(movement.rotation.distanceTo(heading).angle) < 0.7 ? 1 : 0;
}

// --- Events that hand a serialized escort to the owning client ---

export interface EscortJump {
    entity: Entity,
    uuid: string,
    /** Destination system id. */
    to: string,
    /** The player ship whose jump this escort is following. */
    player: string,
}
export const EscortJumpEvent = new EcsEvent<EscortJump>('EscortJumpEvent');

export interface EscortLanded {
    entity: Entity,
    uuid: string,
    /** The player ship this escort belongs to. */
    player: string,
    /** Entity uuid of the stellar it landed on. */
    planet: string,
}
export const EscortLandedEvent =
    new EcsEvent<EscortLanded>('EscortLandedEvent');

/**
 * Codec for an event that carries a whole serialized entity plus some
 * plain fields — the FinishJumpEvent pattern (jump_plugin), shared by the
 * two escort carry events. Carrying the ENTITY (rather than a ship id) is
 * what preserves damage, outfits, cargo, and bay-fighter identity
 * (OwnerComponent / SourceComponent / any future BayFighterComponent)
 * across the round trip: anything the serializer knows about survives
 * without this module having to know it exists.
 */
function escortCarryEventType<Rest extends object>(
    name: string, restType: t.Type<Rest, Rest>, serializer: Serializer,
): t.Type<Rest & { entity: Entity }, Rest & { entity: EncodedEntity }> {
    const EncodedCarry = t.intersection([restType,
        t.type({ entity: EncodedEntity })]);
    return new t.Type<Rest & { entity: Entity },
        Rest & { entity: EncodedEntity }>(
        name,
        (_u): _u is Rest & { entity: Entity } => true,
        (input, context) => {
            const encoded = EncodedCarry.validate(input, context);
            if (isLeft(encoded)) {
                return encoded;
            }
            const { entity, ...rest } = encoded.right;
            const decoded = serializer.decode(entity);
            if (isLeft(decoded)) {
                return t.failure(entity, context,
                    serializer.describeDecodeFailure(entity, decoded.left));
            }
            return t.success({
                ...(rest as unknown as Rest),
                entity: decoded.right,
            });
        },
        ({ entity, ...rest }) => ({
            ...restType.encode(rest as unknown as Rest),
            entity: serializer.encode(entity),
        }),
    );
}

const EscortJumpRest = t.type({
    uuid: t.string,
    to: t.string,
    player: t.string,
});
const EscortLandedRest = t.type({
    uuid: t.string,
    player: t.string,
    planet: t.string,
});

registerSimulationBridgeEvent({ event: EscortJumpEvent });
registerSimulationBridgeEvent({ event: EscortLandedEvent });

// --- Systems ---

/**
 * Stamps the durable ownership marker on every ship whose escort chain
 * tops out at a player-controlled ship. Runs over ships (not just
 * followers) because the chain edge can be any of formation / bay owner /
 * firing group, and re-stamps whenever the live chain says something
 * different — but stays SILENT when the chain reaches nobody, which is
 * how ownership survives the player being out of the world.
 *
 * Excluded:
 *  - player ships themselves (ControlledByComponent),
 *  - mission ships (MissionShipComponent), which already have their own
 *    respawn-with-the-player flow (mission_ship_spawn) and would be
 *    double-spawned if this module carried them too.
 *
 * Deterministic: per entity the answer is a pure function of the synced
 * chain components, with no accumulation over entity-map iteration order.
 */
export const MarkPlayerEscortsSystem = new System({
    name: 'MarkPlayerEscorts',
    args: [UUID, GetEntity, ShipComponent, Entities] as const,
    step(uuid, entity, _ship, entities) {
        if (entity.components.has(ControlledByComponent)
            || entity.components.has(MissionShipComponent)) {
            return;
        }
        const link = playerEscortLink(uuid, other => entities.get(other));
        if (!link) {
            return;
        }
        const existing = entity.components.get(PlayerEscortComponent);
        if (existing?.player === link.player
            && existing.parent === link.parent) {
            return;
        }
        // Preserve the pending-return flag so this system's ordering
        // against EscortReattachSystem cannot matter.
        entity.components.set(PlayerEscortComponent, existing?.detached
            ? { ...link, detached: true } : link);
    },
});

/**
 * The player landed: their escorts head for the same stellar.
 *
 * Runs on the landing ship (LandEvent is targeted at it) on every peer,
 * so every peer stamps the same orders. Gates (hypergates and wormholes)
 * are skipped: those move the player to another system through the gate
 * flow, which has no escort carry yet (documented seam) — the escorts
 * stay in this system, still owned.
 */
export const EscortLandOrderSystem = new System({
    name: 'EscortLandOrder',
    events: [LandEvent],
    args: [UUID, LandEvent, Entities] as const,
    step(playerUuid, land, entities) {
        const planet = entities.get(land.uuid);
        if (!planet || planet.components.get(PlanetDataComponent)?.gate) {
            return;
        }
        for (const [, escort] of entities) {
            if (escort.components.get(PlayerEscortComponent)?.player
                !== playerUuid) {
                continue;
            }
            escort.components.set(EscortLandingComponent,
                { planet: land.uuid });
            // A fighter that was flying home to its bay lands on the
            // planet instead — its carrier is leaving the system, so
            // there is no bay to reach.
            escort.components.delete(ReturnComponent);
            escort.components.delete(CollectableEscortComponent);
        }
    },
});

/**
 * Tracks whether an escort's player is in the world, and re-attaches the
 * escort the moment it comes back: restores the formation link, resets the
 * command to 'formation', and re-stamps the player's firing group.
 *
 * This is the deliberate alternative to suppressing FormationSystem's
 * leader-gone deletion. Letting the formation link lapse while the player
 * is away keeps NPC behavior identical (a follower whose leader really
 * died still reverts to its own AI, and nothing freezes waiting for a
 * leader that will never return), while PlayerEscortComponent carries the
 * ownership that must not be lost. Rebuilding the link here covers, with
 * one rule:
 *  - an escort that was still flying toward the planet when the player
 *    lifted off (its landing order is dropped and it falls straight back
 *    into formation — the case Matthew's spec calls out),
 *  - an escort that never got a landing order at all,
 *  - an escort that held its formation link the whole time because it was
 *    under a non-formation command (its command still gets reset),
 *  - an escort orphaned by any other momentary player absence.
 *
 * A fighter under the 'returnToBay' command is left alone: it is already
 * flying home and must not be yanked back into formation.
 *
 * Runs ONCE per tick over the whole escort set (on the singleton entity)
 * rather than per escort, and walks it in uuid order. Slot allocation is
 * the reason: nextFormationSlot takes a max over the LIVE entity map, and
 * this system writes FormationComponent as it goes, so two escorts
 * re-attaching on the same tick — the ordinary case when a player lands
 * with a wing and lifts off again — would be handed slots in entity-map
 * iteration order. That is not a deterministic order across peers (a
 * world rebuilt from a wire baseline can iterate differently), and slot
 * numbers are hashed simulation state that drives station geometry, so
 * per-entity allocation would desync. A fixed uuid sort makes the batch's
 * assignment identical everywhere.
 */
const PlayerEscortsQuery = new Query(
    [UUID, GetEntity, PlayerEscortComponent] as const);

export const EscortReattachSystem = new System({
    name: 'EscortReattach',
    args: [PlayerEscortsQuery, Entities, SingletonComponent] as const,
    step(escorts, entities) {
        const inUuidOrder = [...escorts].sort(
            ([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        for (const [uuid, entity, owned] of inUuidOrder) {
            if (!entities.has(owned.player)) {
                // Landed, jumped, or otherwise out of the world. Ownership
                // waits; note the absence so the return is a real
                // boundary. Written once, not every tick: an idempotent
                // re-write would churn the component (and its hash) for
                // the whole landing.
                if (!owned.detached) {
                    owned.detached = true;
                }
                continue;
            }
            if (!owned.detached) {
                continue; // Steady state: no per-tick writes at all.
            }
            if (entity.components.get(EscortCommandComponent)?.command
                === 'returnToBay') {
                // Flying home to a bay: leave it be, but stop treating the
                // player's return as pending. Any landing order is dropped
                // all the same — the player is back, so nothing should
                // still be flying down to a planet.
                entity.components.delete(EscortLandingComponent);
                owned.detached = false;
                continue;
            }
            // Prefer the escort's own carrier (a fighter launched from an
            // escort's bays), falling back to the player.
            const leaderUuid = owned.parent !== undefined
                && owned.parent !== uuid && entities.has(owned.parent)
                ? owned.parent : owned.player;
            if (leaderUuid === uuid) {
                owned.detached = false;
                continue;
            }
            const formation = entity.components.get(FormationComponent);
            entity.components.set(FormationComponent, {
                leader: leaderUuid,
                slot: formation?.leader === leaderUuid ? formation.slot
                    : nextFormationSlot(formationsIn(entities), leaderUuid),
            });
            // Explicit command reset at a lifecycle boundary (see the
            // module comment): a re-attached escort always starts from
            // formation.
            entity.components.set(EscortCommandComponent,
                { command: 'formation' });
            entity.components.set(FiringGroupComponent,
                { group: owned.player });
            entity.components.delete(EscortLandingComponent);
            owned.detached = false;
        }
    },
    before: [FormationSystem],
});

/**
 * The player is departing into hyperspace: their escorts leave with them.
 *
 * Each follower is serialized out of this system and handed to the owning
 * client, which inserts it into the destination system beside the player
 * (browser.ts). Ordered BEFORE JumpFromSystem so the escort carry events
 * precede the player's FinishJumpEvent in the frame's event list — the
 * client collects the escorts synchronously and consumes them inside the
 * (asynchronous) jump handler, so they are always in hand before
 * teardownActiveSystem drops the old system's entities.
 *
 * Escorts jump for FREE: no fuel is deducted, because an escort must
 * always be able to follow. A ship with zero energy capacity
 * (FuelComponent.max === 0, i.e. shïp "energy" 0) has no hyperdrive at
 * all and is left behind — still marked owned, so it is recovered if the
 * player ever returns to this system.
 */
export const EscortFollowJumpSystem = new System({
    name: 'EscortFollowJump',
    events: [InitiateJumpEvent],
    args: [UUID, InitiateJumpEvent, ControlledByComponent, Entities,
        Emit] as const,
    step(playerUuid, { to }, _controlledBy, entities, emit) {
        const following: string[] = [];
        for (const [escortUuid, escort] of entities) {
            if (escort.components.get(PlayerEscortComponent)?.player
                !== playerUuid) {
                continue;
            }
            const fuel = escort.components.get(FuelComponent);
            if (!fuel || fuel.max <= 0) {
                continue;
            }
            following.push(escortUuid);
        }
        for (const escortUuid of following) {
            const escort = entities.get(escortUuid);
            if (!escort) {
                continue;
            }
            // A landing order does not survive the jump: the stellar it
            // named is in the system being left behind.
            escort.components.delete(EscortLandingComponent);
            entities.delete(escortUuid);
            deImmerify(escort);
            emit(EscortJumpEvent,
                { entity: escort, uuid: escortUuid, to, player: playerUuid },
                [escortUuid]);
        }
    },
    before: [JumpFromSystem],
});

/**
 * Flies a landing escort to its stellar and, inside the relaxed landing
 * window, removes it from the simulation and hands the whole serialized
 * entity to the owning client (EscortLandedEvent). The despawn is
 * simulation state (every peer does it); the roster the event feeds is
 * per-player client state.
 *
 * Ordered AFTER EscortReattachSystem, which closes a stranding race: the
 * player's relaunch arrives as an input record applied before the tick's
 * systems run, so in that tick the re-attach clears the landing order
 * BEFORE this system could despawn an escort that happened to be sitting
 * inside the landing window — an escort whose capture would arrive after
 * the client had already consumed and re-inserted its roster.
 */
export const EscortLandingSystem = new System({
    name: 'EscortLanding',
    args: [EscortLandingComponent, PlayerEscortComponent,
        MovementStateComponent, ShipPhysicsComponent, TimeResource,
        Entities, GetEntity, UUID, Emit] as const,
    step(landing, owned, movement, physics, time, entities, entity, uuid,
        emit) {
        const planetPosition = entities.get(landing.planet)?.components
            .get(MovementStateComponent)?.position;
        if (!planetPosition) {
            // The stellar is gone (system rebuilt under us): stand down
            // and let the re-attach / normal AI take over again.
            entity.components.delete(EscortLandingComponent);
            return;
        }
        const target = Position.fromVectorLike(planetPosition);
        const distanceSquared =
            target.subtract(movement.position).lengthSquared;
        if (distanceSquared <= ESCORT_LAND_DISTANCE_SQUARED
            && movement.velocity.lengthSquared <= ESCORT_LAND_SPEED_SQUARED) {
            // Landed. The order is dropped before the entity is captured
            // so the escort comes back out of the roster clean.
            entity.components.delete(EscortLandingComponent);
            entities.delete(uuid);
            deImmerify(entity);
            emit(EscortLandedEvent, {
                entity, uuid, player: owned.player, planet: landing.planet,
            }, [uuid]);
            return;
        }
        steerToStellar(movement, target, physics.acceleration, physics.speed,
            time.delta_s);
    },
    after: [TimeSystem, EscortReattachSystem],
    before: [MovementSystem],
});

export const PlayerEscortPlugin: Plugin = {
    name: 'PlayerEscortPlugin',
    build(world) {
        const serializer = world.resources.get(SerializerResource);
        // Both components are real simulation state AND must ride the
        // serialized entity across a landing or a jump, so they are
        // serializer-registered (which also puts them in desync hashes,
        // rollback snapshots via the default codec policy, and wire
        // baselines).
        serializer?.addComponent(PlayerEscortComponent, PlayerEscort);
        serializer?.addComponent(EscortLandingComponent, EscortLanding);
        if (serializer) {
            serializer.addEvent(EscortJumpEvent, escortCarryEventType(
                'EscortJumpEventType', EscortJumpRest, serializer));
            serializer.addEvent(EscortLandedEvent, escortCarryEventType(
                'EscortLandedEventType', EscortLandedRest, serializer));
        }
        world.addSystem(MarkPlayerEscortsSystem);
        world.addSystem(EscortLandOrderSystem);
        world.addSystem(EscortLandingSystem);
        world.addSystem(EscortFollowJumpSystem);
        world.addSystem(EscortReattachSystem);
    },
};
