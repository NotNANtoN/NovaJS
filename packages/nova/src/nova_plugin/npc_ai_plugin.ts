import * as t from 'io-ts';
import { Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementState, MovementStateComponent, MovementSystem } from 'nova_ecs/plugins/movement_plugin';
import { Random, RandomResource } from 'nova_ecs/plugins/random_plugin';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { TimeResource, TimeSystem } from 'nova_ecs/plugins/time_plugin';
import { Query } from 'nova_ecs/query';
import { RunQuery } from 'nova_ecs/arg_types';
import { System } from 'nova_ecs/system';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { CloakActiveComponent, isTargetable } from './cloak_plugin.js';
import { DamagedEvent } from './death_plugin.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { GovtComponent } from './govt_component.js';
import { govtDisposition, effectiveStrength, oddsFavorable } from './govt_disposition.js';
import { ArmorComponent, ShieldComponent } from './health_plugin.js';
import { JUMP_DISTANCE, JUMP_ARRIVAL_MARGIN_S } from './jump_plugin.js';
import { PlanetComponent } from './planet_plugin.js';
import { SourceComponent } from './fire_weapon_plugin.js';
import { ShipComponent, ShipDataComponent, ShipPhysicsComponent } from './ship_plugin.js';
import { TargetComponent } from './target_component.js';
import { WeaponsStateComponent } from './weapons_state.js';

/**
 * ============================================================================
 * NPC AI (EVN Bible AITypes 1-4, simplified but distinct)
 * ============================================================================
 *
 * Everything here runs DETERMINISTICALLY IN THE SHARED SIMULATION on
 * every peer: state lives in serializer-registered components, timers
 * use TimeResource, randomness comes only from the seeded
 * RandomResource, and candidate selection breaks ties by uuid. This is
 * the designed endpoint of the AI architecture — the older marker-
 * component AI in npc_plugin.ts (ChooseRandomTarget/Follow/ShootAll)
 * predates rollback multiplayer and survives only as a primitive for
 * dev-spawned test ships and bay fighters in combat; new NPC behavior
 * belongs here.
 *
 * The Bible specifies the STRUCTURE of the four AI types but not their
 * steering geometry, so the numbers below (ranges, dwell times,
 * formation spacing) are judgment calls, kept as named constants for
 * tuning:
 *
 *  1 wimpy trader:  flies planet to planet (arrive -> dwell -> next),
 *                   flees for a jump-out when attacked.
 *  2 brave trader:  same, but fights its attacker back while the govt
 *                   MaxOdds calculation stays favorable, then flees.
 *  3 warship:       hunts govt enemies (disposition via GovtData
 *                   classes/allies/enemies); patrols waypoints when
 *                   there is nothing to hunt; jumps out eventually.
 *  4 interceptor:   orbits a home planet and engages govt enemies that
 *                   come within its engagement bubble. (The Bible's
 *                   cargo-scanning "buzz" and piracy-police reactions
 *                   are not modeled: scanning and boarding don't exist
 *                   in the sim yet.)
 *
 * NPC departure is a simplified "depart at the edge": the ship flies
 * beyond the no-jump radius plus the same arrival margin jump_plugin
 * uses and is deleted, standing in for a hyperspace exit. It does NOT
 * reuse the JumpComponent state machine: that machine ends by emitting
 * FinishJumpEvent, which carries the serialized entity to a concrete
 * destination world — machinery (and cost) that only matters for ships
 * a player is aboard. A visible NPC warp-out flash is future polish.
 */

// --- Tuning constants ---

/** Base think interval; divided by the govt's SkillMult/100, so more
 * skilled governments react faster (the natural home for SkillMult
 * until per-ship stat scaling exists). */
export const NPC_DECISION_INTERVAL_MS = 1000;
/** How long a trader loiters at a planet, standing in for landing
 * (real landing would despawn/respawn the ship; not worth it yet). */
export const TRADER_DWELL_MS = 12_000;
/** Traders arrive at a planet within this distance... */
const PLANET_ARRIVE_RADIUS = 90;
/** ...and below this speed (matches AttemptLandingSystem's numbers:
 * dist^2 < 10000, speed^2 < 3000). */
const PLANET_ARRIVE_SPEED = 50;
/** Distance at which an arriving ship starts braking. */
const ARRIVE_SLOW_RADIUS = 400;
/** Warship patrol waypoints are drawn within this box half-size —
 * matching the asteroid field, where gameplay happens. */
const PATROL_HALF_SIZE = 2000;
/** A patrol waypoint counts as reached within this distance. */
const WAYPOINT_RADIUS = 200;
/** Interceptors orbit their home planet at this radius... */
const INTERCEPTOR_ORBIT_RADIUS = 400;
/** ...advancing their orbit waypoint by this angle when they reach it. */
const INTERCEPTOR_ORBIT_STEP = Math.PI / 4;
/** Interceptors engage enemies within this range of themselves or
 * their home planet. */
export const INTERCEPTOR_ENGAGE_RANGE = 1800;
/** Warships hunt enemies anywhere in the inhabited field; beyond this
 * they don't see them (keeps fights near the action). */
export const WARSHIP_ENGAGE_RANGE = 6000;
/** Attackers stop thrusting toward their target inside this range. */
const ATTACK_STANDOFF = 250;
/** NPCs only fire within this range of their target. */
const NPC_FIRE_RANGE = 1200;
/** NPCs stay in the system between these bounds before jumping out. */
export const NPC_DEPART_MIN_MS = 120_000;
export const NPC_DEPART_MAX_MS = 300_000;
/** Fleeing/departing ships are deleted ("jump out") beyond this radius. */
export const NPC_DEPART_RADIUS = JUMP_DISTANCE + 500 * JUMP_ARRIVAL_MARGIN_S;

// --- Formation tuning ---

/** Longitudinal spacing between formation rows, px. */
export const FORMATION_ROW_SPACING = 120;
/** Lateral spacing between the two slots of a row, px. */
export const FORMATION_LATERAL_SPACING = 110;
/** How far ahead (seconds) followers lead the slot by the leader's
 * velocity, so they fly toward where the slot is going. */
const FORMATION_LOOKAHEAD_S = 0.4;
/** Position error is converted to closing velocity at this rate (1/s):
 * the proportional term of the follower controller. */
const FORMATION_POSITION_GAIN = 1.2;
/** Followers stop thrusting when their correction is smaller than
 * this (px/s) — inside it they coast with the leader. */
const FORMATION_DEADBAND = 30;

export const NpcMode = t.union([
    t.literal('travel'), t.literal('dwell'), t.literal('flee'),
    t.literal('attack'), t.literal('patrol'), t.literal('depart')]);
export type NpcMode = t.TypeOf<typeof NpcMode>;

export const NpcState = t.intersection([t.type({
    /** Effective AI type 1-4 (düde AIType, or the shïp InherentAI when
     * the düde says 0). */
    aiType: t.number,
}), t.partial({
    mode: NpcMode,
    /** Planet uuid: travel destination (traders) or home (interceptors). */
    destination: t.string,
    /** Current waypoint (patrol legs, orbit points, flee headings). */
    waypoint: t.tuple([t.number, t.number]),
    /** Sim time (ms) when the current dwell ends. */
    until: t.number,
    /** Sim time (ms) of the next decision re-evaluation. */
    nextDecision: t.number,
    /** Uuid of the ship that most recently damaged this NPC. */
    aggressor: t.string,
    /** Sim time (ms) after which the NPC heads for a jump-out. */
    departAt: t.number,
})]);
export type NpcState = t.TypeOf<typeof NpcState>;
export const NpcComponent = new Component<NpcState>('NpcComponent');

/**
 * Holds an escort in a deterministic formation slot on its leader when
 * it is not engaged. Used by fleet escorts and by bay fighters that
 * have no target.
 */
export const Formation = t.intersection([t.type({
    /** Leader entity uuid. */
    leader: t.string,
    /** 0-based slot index; see formationOffset for the geometry. */
    slot: t.number,
}), t.partial({
    /** Bay fighters: sim time (ms) at which the fighter stops holding
     * and turns home to dock (see bay_plugin). */
    dockAt: t.number,
})]);
export type Formation = t.TypeOf<typeof Formation>;
export const FormationComponent = new Component<Formation>('FormationComponent');

/**
 * Formation slot geometry: a V behind the leader. Slots pair up into
 * rows (slot 0 right of the leader's wake, slot 1 left, slot 2 right
 * one row further back, ...), each row FORMATION_ROW_SPACING behind
 * the previous and fanning outward by FORMATION_LATERAL_SPACING.
 */
export function formationOffset(slot: number): { back: number, lateral: number } {
    const row = Math.floor(slot / 2) + 1;
    const side = slot % 2 === 0 ? 1 : -1;
    return {
        back: row * FORMATION_ROW_SPACING,
        lateral: side * row * FORMATION_LATERAL_SPACING,
    };
}

/** The world-space position of a leader's formation slot. */
export function formationSlotPosition(leaderPosition: Position,
    leaderRotation: Angle, slot: number): Position {
    const { back, lateral } = formationOffset(slot);
    const u = leaderRotation.getUnitVector();
    // Perpendicular (rotate u by +90°).
    const p = new Vector(-u.y, u.x);
    return new Position(
        leaderPosition.x - u.x * back + p.x * lateral,
        leaderPosition.y - u.y * back + p.y * lateral);
}

/**
 * A candidate hostile for target selection: uuid plus its squared
 * distance. Selection picks the nearest; exactly equal distances break
 * ties by the lexicographically smaller uuid so every peer picks the
 * same target regardless of entity-map iteration order (the same rule
 * ChooseTargetSystem uses).
 */
export function chooseNearest(
    candidates: Iterable<readonly [string, number]>): string | undefined {
    let best: string | undefined;
    let bestDistance = Infinity;
    for (const [uuid, distanceSquared] of candidates) {
        if (distanceSquared < bestDistance
            || (distanceSquared === bestDistance
                && best !== undefined && uuid < best)) {
            best = uuid;
            bestDistance = distanceSquared;
        }
    }
    return best;
}

function randomBetween(random: Random, min: number, max: number): number {
    return min + random.next() * (max - min);
}

/** Draws the sim time at which a freshly spawned NPC will depart. */
export function rollDepartureTime(now: number, random: Random): number {
    return now + randomBetween(random, NPC_DEPART_MIN_MS, NPC_DEPART_MAX_MS);
}

// --- Aggression tracking ---

const DamagerSourceQuery = new Query([Optional(SourceComponent)] as const);

/**
 * Records who last damaged an NPC. The damager of a DamagedEvent is
 * the projectile/beam entity; its SourceComponent is the firing ship.
 */
const NpcAggressionSystem = new System({
    name: 'NpcAggressionSystem',
    events: [DamagedEvent],
    args: [DamagedEvent, NpcComponent, UUID, RunQuery] as const,
    step({ damager }, npc, uuid, runQuery) {
        const source = runQuery(DamagerSourceQuery, damager)[0]?.[0];
        if (source && source !== uuid) {
            npc.aggressor = source;
            // React at the next think, not next frame: reaction time.
        }
    },
});

// --- Decision making ---

const PlanetsQuery = new Query(
    [UUID, MovementStateComponent, PlanetComponent] as const);
const NpcTargetsQuery = new Query([UUID, MovementStateComponent, ShipComponent,
    ShipDataComponent, Optional(GovtComponent), Optional(ShieldComponent),
    Optional(CloakActiveComponent)] as const);

function lookupGovt(gameData: SimulationGameDataInterface,
    govt: { id: string } | undefined) {
    // getCached is deterministic here because NPC spawning stages every
    // govt it assigns, and player ships have no govt. A ship arriving
    // via wire snapshot goes through loadWireSnapshotGameData, which
    // stages its govt too.
    return govt ? gameData.data.Govt.getCached(govt.id) : undefined;
}

function shieldFraction(shield: { current: number, max: number } | undefined) {
    if (!shield || shield.max <= 0) {
        return 1;
    }
    return Math.max(0, shield.current / shield.max);
}

/** Picks the next planet a trader heads for (uuid order for
 * determinism; Random for variety; excludes the one it's at). */
function pickPlanet(planets: Array<readonly [string, MovementState, unknown]>,
    random: Random, exclude?: string): string | undefined {
    const ids = planets.map(([uuid]) => uuid)
        .filter(uuid => uuid !== exclude)
        .sort();
    if (ids.length === 0) {
        return undefined;
    }
    return ids[random.below(ids.length)];
}

function nearestPlanet(planets: Array<readonly [string, MovementState, unknown]>,
    position: Position): string | undefined {
    return chooseNearest(planets.map(([uuid, movement]) => [uuid,
        movement.position.subtract(position).lengthSquared] as const));
}

/**
 * The per-NPC think step. Runs at NPC_DECISION_INTERVAL_MS (scaled by
 * the govt's SkillMult) and owns all mode transitions; the steering
 * system below only executes the current mode.
 */
const NpcDecisionSystem = new System({
    name: 'NpcDecisionSystem',
    args: [NpcComponent, MovementStateComponent, TargetComponent,
        Optional(GovtComponent), Optional(ShieldComponent),
        ShipDataComponent, Optional(FormationComponent), NpcTargetsQuery,
        PlanetsQuery, TimeResource, RandomResource, Entities, UUID,
        SimulationGameDataResource] as const,
    step(npc, movement, target, govt, shield, shipData, formation, ships,
        planets, time, random, entities, uuid, gameData) {
        if (npc.mode === 'depart') {
            return;
        }
        const govtData = lookupGovt(gameData, govt);
        if ((npc.nextDecision ?? 0) > time.time) {
            return;
        }
        const skillMult = Math.max(1, govtData?.skillMult ?? 100);
        npc.nextDecision = time.time
            + NPC_DECISION_INTERVAL_MS * 100 / skillMult;
        if (npc.departAt === undefined) {
            npc.departAt = rollDepartureTime(time.time, random);
        }

        // Forget aggressors that no longer exist.
        if (npc.aggressor && !entities.has(npc.aggressor)) {
            npc.aggressor = undefined;
        }

        const position = Position.fromVectorLike(movement.position);
        const myStrength = effectiveStrength(
            shipData.strength, shieldFraction(shield));

        // Gather enemies: govt-hostile ships plus the recorded
        // aggressor, cloaked ships excluded (invisible to AI).
        const hostiles: Array<readonly [string, number]> = [];
        let aggressorEntry: readonly [string, number, number] | undefined;
        for (const [otherUuid, otherMovement, , otherData, otherGovt,
            otherShield, cloak] of ships) {
            if (otherUuid === uuid || !isTargetable(cloak)) {
                continue;
            }
            const distanceSquared = otherMovement.position
                .subtract(position).lengthSquared;
            const otherStrength = effectiveStrength(
                otherData.strength, shieldFraction(otherShield));
            if (otherUuid === npc.aggressor) {
                aggressorEntry = [otherUuid, distanceSquared, otherStrength];
            }
            const disposition = govtDisposition(govtData,
                lookupGovt(gameData, otherGovt));
            if (disposition === 'enemy') {
                hostiles.push([otherUuid, distanceSquared] as const);
            }
        }

        switch (npc.aiType) {
            case 2: // Brave trader: fight back while the odds hold.
                if (aggressorEntry) {
                    const favorable = oddsFavorable(govtData?.maxOdds ?? 100,
                        myStrength, aggressorEntry[2]);
                    if (favorable) {
                        npc.mode = 'attack';
                        target.target = aggressorEntry[0];
                        return;
                    }
                    npc.mode = 'flee';
                    return;
                }
                if (npc.mode === 'attack' || npc.mode === 'flee') {
                    // Attacker gone or lost: back to business.
                    npc.mode = undefined;
                    target.target = undefined;
                }
                break;
            case 1: // Wimpy trader: any aggression means run.
                if (aggressorEntry) {
                    npc.mode = 'flee';
                    return;
                }
                if (npc.mode === 'flee') {
                    npc.mode = undefined;
                }
                break;
        }

        switch (npc.aiType) {
            case 1:
            case 2: {
                // Planet-to-planet loop.
                if (npc.mode === 'travel') {
                    if (!npc.destination || !entities.has(npc.destination)) {
                        npc.mode = undefined;
                    }
                } else if (npc.mode === 'dwell') {
                    if (time.time >= (npc.until ?? 0)) {
                        if (time.time >= npc.departAt) {
                            npc.mode = 'depart';
                            return;
                        }
                        npc.destination = pickPlanet(
                            planets, random, npc.destination);
                        npc.mode = npc.destination ? 'travel' : 'depart';
                    }
                }
                if (npc.mode === undefined) {
                    npc.destination = pickPlanet(planets, random);
                    npc.mode = npc.destination ? 'travel' : 'depart';
                }
                break;
            }
            case 3: { // Warship: hunt, else patrol; jump out eventually.
                if (govtData?.flags.warshipsRetreatAt25
                    && shield && shield.max > 0
                    && shield.current < 0.25 * shield.max) {
                    npc.mode = 'flee';
                    target.target = undefined;
                    return;
                }
                const engageable = hostiles.filter(([, d2]) =>
                    d2 <= WARSHIP_ENGAGE_RANGE * WARSHIP_ENGAGE_RANGE);
                if (aggressorEntry) {
                    engageable.push([aggressorEntry[0], aggressorEntry[1]]);
                }
                const chosen = chooseNearest(engageable);
                if (chosen) {
                    // MaxOdds: engage only while the fight looks
                    // favorable (per-pair simplification of the
                    // Bible's friends-vs-enemies strength sums).
                    const chosenEntry = ships.find(([u]) => u === chosen);
                    const chosenStrength = chosenEntry ? effectiveStrength(
                        chosenEntry[3].strength,
                        shieldFraction(chosenEntry[5])) : 0;
                    if (oddsFavorable(govtData?.maxOdds ?? 100,
                        myStrength, chosenStrength)) {
                        npc.mode = 'attack';
                        target.target = chosen;
                        return;
                    }
                }
                if (npc.mode === 'attack' || npc.mode === 'flee') {
                    npc.mode = undefined;
                    target.target = undefined;
                }
                if (time.time >= npc.departAt) {
                    npc.mode = 'depart';
                    return;
                }
                if (npc.mode === undefined || npc.mode === 'patrol') {
                    // In formation with a live leader: hold instead of
                    // patrolling on our own.
                    if (formation && entities.has(formation.leader)) {
                        npc.mode = 'patrol';
                        npc.waypoint = undefined;
                        return;
                    }
                    const [x, y] = npc.waypoint ?? [0, 0];
                    const reached = npc.waypoint === undefined
                        || new Vector(x - position.x, y - position.y)
                            .lengthSquared < WAYPOINT_RADIUS * WAYPOINT_RADIUS;
                    if (reached) {
                        npc.waypoint = [
                            randomBetween(random,
                                -PATROL_HALF_SIZE, PATROL_HALF_SIZE),
                            randomBetween(random,
                                -PATROL_HALF_SIZE, PATROL_HALF_SIZE)];
                    }
                    npc.mode = 'patrol';
                }
                break;
            }
            case 4: { // Interceptor: orbit home, engage intruders.
                if (!npc.destination || !entities.has(npc.destination)) {
                    npc.destination = nearestPlanet(planets, position);
                    npc.waypoint = undefined;
                }
                const home = npc.destination
                    ? entities.get(npc.destination)?.components
                        .get(MovementStateComponent)?.position
                    : undefined;
                const engageable = hostiles.filter(([otherUuid, d2]) => {
                    if (d2 <= INTERCEPTOR_ENGAGE_RANGE
                        * INTERCEPTOR_ENGAGE_RANGE) {
                        return true;
                    }
                    if (!home) {
                        return false;
                    }
                    const otherMovement = entities.get(otherUuid)
                        ?.components.get(MovementStateComponent);
                    return otherMovement !== undefined
                        && otherMovement.position.subtract(home).lengthSquared
                        <= INTERCEPTOR_ENGAGE_RANGE * INTERCEPTOR_ENGAGE_RANGE;
                });
                if (aggressorEntry) {
                    engageable.push([aggressorEntry[0], aggressorEntry[1]]);
                }
                const chosen = chooseNearest(engageable);
                if (chosen) {
                    npc.mode = 'attack';
                    target.target = chosen;
                    return;
                }
                if (npc.mode === 'attack') {
                    npc.mode = undefined;
                    target.target = undefined;
                }
                if (time.time >= npc.departAt) {
                    npc.mode = 'depart';
                    return;
                }
                npc.mode = 'patrol';
                if (!home) {
                    // No planets: fall back to warship-style waypoints.
                    if (npc.waypoint === undefined) {
                        npc.waypoint = [
                            randomBetween(random,
                                -PATROL_HALF_SIZE, PATROL_HALF_SIZE),
                            randomBetween(random,
                                -PATROL_HALF_SIZE, PATROL_HALF_SIZE)];
                    }
                    break;
                }
                // Orbit: advance the waypoint around the home planet.
                const homePosition = Position.fromVectorLike(home);
                let orbitAngle: Angle;
                if (npc.waypoint === undefined) {
                    orbitAngle = position.subtract(homePosition).angle;
                } else {
                    const [x, y] = npc.waypoint;
                    const toWaypoint = new Vector(
                        x - position.x, y - position.y);
                    if (toWaypoint.lengthSquared
                        > WAYPOINT_RADIUS * WAYPOINT_RADIUS) {
                        break; // Still flying to the current point.
                    }
                    orbitAngle = new Vector(x - homePosition.x,
                        y - homePosition.y).angle
                        .add(INTERCEPTOR_ORBIT_STEP);
                }
                const unit = orbitAngle.getUnitVector();
                npc.waypoint = [
                    homePosition.x + unit.x * INTERCEPTOR_ORBIT_RADIUS,
                    homePosition.y + unit.y * INTERCEPTOR_ORBIT_RADIUS];
                break;
            }
        }
    },
    after: [TimeSystem],
    before: [MovementSystem],
});

// --- Steering ---

/**
 * Point-and-thrust arrival: turn toward the goal and burn while far;
 * inside the slow radius, turn retrograde and brake until slow.
 * Built from the same movement primitives the jump sequence's
 * 'stopping' stage uses. Returns true once arrived.
 */
export function steerArrive(movement: MovementState, physics: {
    acceleration: number, turnRate: number,
}, goal: Position, arriveRadius: number, arriveSpeed: number): boolean {
    const toGoal = goal.subtract(movement.position);
    const distance = toGoal.length;
    const speed = movement.velocity.length;
    if (distance < arriveRadius && speed < arriveSpeed) {
        movement.accelerating = 0;
        movement.turnTo = null;
        movement.turnBack = false;
        return true;
    }
    // Time to stop at current speed vs. time to reach the goal:
    // brake when stopping distance (with margin) exceeds what's left.
    const stopDistance = physics.acceleration > 0
        ? speed * speed / (2 * physics.acceleration) : 0;
    if (distance < Math.max(arriveRadius, stopDistance * 1.5)
        || (distance < ARRIVE_SLOW_RADIUS && speed > arriveSpeed)) {
        // Brake: turn retrograde, thrust when roughly aligned.
        movement.turnTo = null;
        movement.turnBack = true;
        movement.accelerating = 0;
        if (speed > arriveSpeed * 0.5) {
            const reverse = movement.velocity.angle.add(Math.PI);
            const misalignment = movement.rotation.distanceTo(reverse).angle;
            if (Math.abs(misalignment) < 0.4) {
                movement.accelerating = 1;
            }
        }
        return false;
    }
    // Cruise: point at the goal, thrust when roughly aligned.
    movement.turnBack = false;
    const goalAngle = toGoal.angle;
    movement.turnTo = goalAngle;
    const misalignment = movement.rotation.distanceTo(goalAngle).angle;
    movement.accelerating = Math.abs(misalignment) < 0.6 ? 1 : 0;
    return false;
}

/** Fly outward and report whether the ship has left the system. */
function steerOutward(movement: MovementState, away: Vector): boolean {
    if (movement.position.length > NPC_DEPART_RADIUS) {
        return true;
    }
    const heading = away.lengthSquared > 1e-12 ? away.angle
        : new Angle(0);
    movement.turnTo = heading;
    movement.turnBack = false;
    const misalignment = movement.rotation.distanceTo(heading).angle;
    movement.accelerating = Math.abs(misalignment) < 0.8 ? 1 : 0;
    return false;
}

/**
 * Executes the NPC's current mode every tick. Deleting at the depart
 * radius stands in for jumping out (see the module comment).
 */
const NpcSteeringSystem = new System({
    name: 'NpcSteeringSystem',
    args: [NpcComponent, MovementStateComponent, ShipPhysicsComponent,
        TargetComponent, Optional(FormationComponent), TimeResource,
        Entities, UUID] as const,
    step(npc, movement, physics, target, formation, time, entities, uuid) {
        // Escorts holding formation are steered by FormationSystem.
        if (formation && entities.has(formation.leader)
            && npc.mode !== 'attack' && npc.mode !== 'flee'
            && npc.mode !== 'depart') {
            return;
        }
        switch (npc.mode) {
            case 'travel': {
                const destination = npc.destination
                    ? entities.get(npc.destination)?.components
                        .get(MovementStateComponent)?.position
                    : undefined;
                if (!destination) {
                    return; // Decision system will re-plan.
                }
                const arrived = steerArrive(movement, physics,
                    Position.fromVectorLike(destination),
                    PLANET_ARRIVE_RADIUS, PLANET_ARRIVE_SPEED);
                if (arrived) {
                    npc.mode = 'dwell';
                    npc.until = time.time + TRADER_DWELL_MS;
                }
                break;
            }
            case 'dwell': {
                // Loiter: brake to a stop and sit.
                movement.turnTo = null;
                movement.accelerating = 0;
                const speed = movement.velocity.length;
                movement.turnBack = speed > 10;
                if (speed > 10) {
                    const reverse = movement.velocity.angle.add(Math.PI);
                    if (Math.abs(movement.rotation.distanceTo(reverse).angle)
                        < 0.4) {
                        movement.accelerating = 1;
                    }
                }
                break;
            }
            case 'patrol': {
                if (!npc.waypoint) {
                    return;
                }
                steerArrive(movement, physics,
                    new Position(npc.waypoint[0], npc.waypoint[1]),
                    WAYPOINT_RADIUS, physics.speed);
                break;
            }
            case 'attack': {
                const other = target.target
                    ? entities.get(target.target)?.components
                        .get(MovementStateComponent)
                    : undefined;
                if (!other) {
                    return;
                }
                const toTarget = other.position.subtract(movement.position);
                movement.turnTo = target.target!;
                movement.turnBack = false;
                movement.accelerating =
                    toTarget.length > ATTACK_STANDOFF ? 1 : 0;
                break;
            }
            case 'flee': {
                const aggressor = npc.aggressor
                    ? entities.get(npc.aggressor)?.components
                        .get(MovementStateComponent)
                    : undefined;
                // Run from the attacker; with no attacker position,
                // run outward from the system center.
                const away = aggressor
                    ? movement.position.subtract(aggressor.position)
                    : new Vector(movement.position.x, movement.position.y);
                if (steerOutward(movement, away)) {
                    entities.delete(uuid);
                }
                break;
            }
            case 'depart': {
                const away = new Vector(
                    movement.position.x, movement.position.y);
                if (steerOutward(movement, away)) {
                    entities.delete(uuid);
                }
                break;
            }
        }
    },
    after: [TimeSystem, NpcDecisionSystem],
    before: [MovementSystem],
});

/**
 * Fires every non-bay weapon at the NPC's target while attacking and
 * in range; ceases fire otherwise. (Same bay exclusion as the legacy
 * ShootAllWeaponsAI: bays have no ammo limit yet.)
 */
const NpcFireControlSystem = new System({
    name: 'NpcFireControlSystem',
    args: [NpcComponent, WeaponsStateComponent, TargetComponent,
        MovementStateComponent, Entities,
        SimulationGameDataResource] as const,
    step(npc, weapons, target, movement, entities, gameData) {
        const other = npc.mode === 'attack' && target.target
            ? entities.get(target.target)?.components
                .get(MovementStateComponent)
            : undefined;
        const inRange = other !== undefined
            && other.position.subtract(movement.position).lengthSquared
            <= NPC_FIRE_RANGE * NPC_FIRE_RANGE;
        for (const [id, weapon] of weapons) {
            if (!inRange) {
                weapon.firing = false;
                continue;
            }
            const weaponType = gameData.data.Weapon.getCached(id)?.type;
            if (weaponType == null || weaponType === 'BayWeaponData') {
                continue;
            }
            weapon.target = target.target;
            weapon.firing = true;
        }
    },
    after: [NpcDecisionSystem],
});

// --- Formation keeping ---

/**
 * Steers a follower toward its slot: a proportional controller that
 * chases the slot position (led by the leader's velocity) and matches
 * the leader's velocity inside the deadband. Pure so tests can check
 * the geometry converges.
 */
export function steerFormation(movement: MovementState, leader: MovementState,
    slot: number): void {
    const slotPosition = formationSlotPosition(
        Position.fromVectorLike(leader.position),
        Angle.fromAngleLike(leader.rotation), slot);
    const lead = Vector.fromVectorLike(leader.velocity)
        .scale(FORMATION_LOOKAHEAD_S);
    const error = slotPosition.add(lead).subtract(movement.position);
    // Desired velocity: the leader's, plus a correction proportional
    // to the position error.
    const desired = Vector.fromVectorLike(leader.velocity)
        .add(error.scale(FORMATION_POSITION_GAIN));
    const correction = desired.subtract(movement.velocity);
    if (correction.length < FORMATION_DEADBAND) {
        // On station: coast, aligning with the leader's heading.
        movement.accelerating = 0;
        movement.turnBack = false;
        movement.turnTo = Angle.fromAngleLike(leader.rotation);
        return;
    }
    const heading = correction.angle;
    movement.turnTo = heading;
    movement.turnBack = false;
    const misalignment = movement.rotation.distanceTo(heading).angle;
    movement.accelerating = Math.abs(misalignment) < 0.7 ? 1 : 0;
}

const FormationSystem = new System({
    name: 'FormationSystem',
    args: [FormationComponent, MovementStateComponent,
        Optional(NpcComponent), Entities, GetEntity, UUID] as const,
    step(formation, movement, npc, entities, entity) {
        // Engaged escorts fight; FormationSystem only holds station.
        if (npc && (npc.mode === 'attack' || npc.mode === 'flee'
            || npc.mode === 'depart')) {
            return;
        }
        const leader = entities.get(formation.leader)?.components
            .get(MovementStateComponent);
        if (!leader) {
            // Leader gone: escorts revert to their own AI (the
            // decision system re-plans since mode stays whatever it
            // was); bay fighters are handed back to bay_plugin, which
            // watches for this.
            entity.components.delete(FormationComponent);
            return;
        }
        steerFormation(movement, leader, formation.slot);
    },
    after: [TimeSystem, NpcDecisionSystem],
    before: [MovementSystem],
});

export const NpcAiPlugin: Plugin = {
    name: 'NpcAiPlugin',
    build(world) {
        const serializer = world.resources.get(SerializerResource);
        // Serializer registration makes NPC AI state real simulation
        // state: hashed for desync detection, cloned into rollback
        // snapshots, and carried by wire baselines — the opposite of
        // the legacy owner-only AI, whose components were excluded
        // from multiplayer state.
        serializer?.addComponent(NpcComponent, NpcState);
        serializer?.addComponent(FormationComponent, Formation);
        world.addSystem(NpcAggressionSystem);
        world.addSystem(NpcDecisionSystem);
        world.addSystem(NpcSteeringSystem);
        world.addSystem(NpcFireControlSystem);
        world.addSystem(FormationSystem);
    },
};
