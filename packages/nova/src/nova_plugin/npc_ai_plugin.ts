import * as t from 'io-ts';
import { Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { EntityMap } from 'nova_ecs/entity_map';
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
import { DamagedEvent, ExplodingComponent } from './death_plugin.js';
import { DisabledComponent, DisabledState } from './disabled_component.js';
import { EscortCommandComponent } from './escort_command.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { GovtComponent } from './govt_component.js';
import { AssistingComponent } from './hail_component.js';
import { govtDispositionTo, effectiveStrength, oddsFavorable } from './govt_disposition.js';
import { ArmorComponent, ShieldComponent } from './health_plugin.js';
import { beginDepartureJump, JumpComponent, JumpSequenceSystem, JUMP_DISTANCE, JUMP_ARRIVAL_MARGIN_S } from './jump_plugin.js';
import { PlanetData } from 'novadatainterface/planet_data';
import { ShipPhysics } from 'novadatainterface/ship_data';
import { PlanetComponent, PlanetDataComponent } from './planet_plugin.js';
import { EscortLandingComponent } from './player_escort.js';
import { LegalRecordsComponent } from './reputation_plugin.js';
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
 * NPC DEPARTURE runs the real hyperspace jump sequence. A ship that is
 * departing or fleeing enters jump_plugin's JumpComponent state machine
 * (beginDepartureJump) and plays every visible stage a player's ship
 * plays — coming to a stop, turning onto its jump heading, spinning up
 * the hyperdrive, then the departure burn — and only leaves the world
 * at the end of it. Big slow-turning ships are the case that motivated
 * this: they used to pop out of existence mid-turn.
 *
 * The stage machine is REUSED, not duplicated. The only thing that
 * differs from a player's jump is the terminal: an NPC has no route and
 * no destination room to be carried to, so its JumpComponent is marked
 * `vanish` and departure simply deletes it (see JumpStateType). That also
 * keeps NPC jumps clear of the player-only machinery hanging off
 * InitiateJumpEvent — the entity serialize-and-carry in JumpFromSystem,
 * and EscortFollowJumpSystem, which would otherwise be the thing that
 * swept a player's escorts along behind a passing NPC.
 *
 * Deleting at NPC_DEPART_RADIUS survives only as the fallback for a
 * ship that cannot jump at all: see NpcSteeringSystem.
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

// JUDGMENT CALL (Matthew wants to tune this): a fleeing ship that is
// far enough out to jump (outside the no-jump radius) jumps away —
// UNLESS its chaser is "right behind it". "Right behind" has no
// original-game definition, so it is defined here as: the chaser is
// within FLEE_JUMP_BLOCK_RANGE px AND inside the cone directly astern
// of the fleeing ship (within FLEE_JUMP_BLOCK_HALF_ANGLE of the
// direction opposite its heading) — close pursuit on its tail. A
// chaser alongside or ahead doesn't stop the jump.
export const FLEE_JUMP_BLOCK_RANGE = 500;
export const FLEE_JUMP_BLOCK_HALF_ANGLE = Math.PI / 3;

/**
 * Whether a pursuer is "right behind" a fleeing ship, blocking its
 * hyperspace escape (see the judgment-call note on the constants).
 */
export function chaserBlocksJump(fleeing: MovementState,
    chaser: MovementState): boolean {
    const toChaser = chaser.position.subtract(fleeing.position);
    if (toChaser.length > FLEE_JUMP_BLOCK_RANGE) {
        return false;
    }
    if (toChaser.lengthSquared < 1e-12) {
        return true;
    }
    const astern = Angle.fromAngleLike(fleeing.rotation).add(Math.PI);
    return Math.abs(astern.distanceTo(toChaser.angle).angle)
        < FLEE_JUMP_BLOCK_HALF_ANGLE;
}

// --- Formation tuning ---

/** Longitudinal spacing between formation rows, px. (Halved from the
 * first-cut 120 after Matthew's playtest: tighter wedge.) */
export const FORMATION_ROW_SPACING = 60;
/** Lateral spacing between adjacent cells of a row, px. (Halved from
 * the first-cut 110.) */
export const FORMATION_LATERAL_SPACING = 55;
/** How far ahead (seconds) followers lead the slot by the leader's
 * velocity, so they fly toward where the slot is going. */
const FORMATION_LOOKAHEAD_S = 0.4;
/** Position error is converted to closing velocity at this rate (1/s):
 * the proportional term of the follower controller. */
const FORMATION_POSITION_GAIN = 1.2;

// --- RCS (reaction control) tuning ---
//
// Ships holding formation get a reaction-control ability: small
// velocity corrections applied directly, WITHOUT rotating the ship,
// so station-keeping doesn't read as constant spin-and-thrust wiggle.
// The ship keeps its heading aligned with the leader's and the main
// engine stays dark (the engine flare is driven by the `accelerating`
// flag — animation_graphic_plugin's glowAlpha — which RCS never sets).
//
// This lives in the AI/steering layer (the formation controller), NOT
// in movement physics: EffectiveMovementPhysicsSystem stays the single
// per-tick writer of MovementPhysics, and RCS is a bounded velocity
// nudge made by steering before MovementSystem integrates — the same
// layer where knockback adjusts velocity. The budget derives from the
// ship's BASE acceleration (ShipPhysics), so afterburners and jump
// drives don't secretly boost thrusterless station-keeping.

/** RCS strength as a fraction of the ship's main-engine acceleration
 * (Matthew's spec: proportional to the ship's acceleration). */
export const RCS_ACCEL_FRACTION = 0.25;
/** Turn-and-burn hands over to RCS when the correction (desired minus
 * actual velocity, px/s) drops below this... */
export const RCS_ENGAGE_SPEED = 60;
/** ...and RCS hands back to turn-and-burn above this. The gap is the
 * hysteresis that stops flip-flopping at the boundary. */
export const RCS_DISENGAGE_SPEED = 120;

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
    /** Uuid of a ship this NPC has been bribed to leave alone (hail bribe /
     * beg-for-mercy). While `pacifiedUntil` has not lapsed, this ship is
     * skipped as a hostile and forgotten as an aggressor. */
    pacifiedFrom: t.string,
    /** Sim time (ms) until which `pacifiedFrom` is ignored. */
    pacifiedUntil: t.number,
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
    /** Whether the follower is currently station-keeping on RCS (the
     * hysteresis state of the formation controller). Sim state: it
     * must roll back and cross the wire with the ship or peers flip
     * modes at different ticks. */
    rcs: t.boolean,
})]);
export type Formation = t.TypeOf<typeof Formation>;
export const FormationComponent = new Component<Formation>('FormationComponent');

/**
 * The first free formation slot on `leaderUuid`: one past the highest
 * slot number any live sibling holds (0 when the leader has no
 * followers yet).
 *
 * COUNTING siblings instead would collide after a mid-formation death:
 * a leader holding slots {0, 1, 2} that loses slot 1 has a sibling
 * count of 2, which is still a live escort's slot, and FormationSystem
 * ranks stations by `siblingSlots.indexOf(slot)` — the two duplicates
 * would resolve to the same rank and stack on one station while
 * another sits empty.
 *
 * Taking a MAX (rather than accumulating) makes the result independent
 * of iteration order, so this is safe to run over an unordered entity
 * map in the deterministic simulation.
 */
export function nextFormationSlot(formations: Iterable<Formation>,
    leaderUuid: string): number {
    let slot = 0;
    for (const formation of formations) {
        if (formation.leader === leaderUuid) {
            slot = Math.max(slot, formation.slot + 1);
        }
    }
    return slot;
}

/**
 * Every formation present in `entities` — the adapter for sim systems
 * that hold an EntityMap rather than a formation query result, so they
 * can feed `nextFormationSlot`.
 */
export function* formationsIn(entities: EntityMap): Iterable<Formation> {
    for (const [, entity] of entities) {
        const formation = entity.components.get(FormationComponent);
        if (formation) {
            yield formation;
        }
    }
}

/**
 * Formation slot geometry: the LEADER is the apex of the triangle, and
 * escort rows widen behind it — row r sits r * FORMATION_ROW_SPACING
 * astern and is (r + 1) cells wide (2, 3, 4, ... cells), each row
 * centered on the leader's axis with adjacent cells
 * FORMATION_LATERAL_SPACING apart. No escort ever occupies the apex
 * (that's the player's ship — Matthew's spec); the first escort row is
 * the flanking pair. RANKS are laid out so that EVERY escort count
 * flies a formation symmetric about the leader's axis. Counts 1-7 use
 * an explicit table (diagrams below — Matthew gets to veto specifics);
 * larger counts fill the widening rows with each row's occupants
 * arranged center-out, which keeps any occupancy symmetric.
 *
 *  count 1        count 2        count 3        count 4
 *     L              L              L              L
 *     1            1   2          1   2          1   2
 *                                   3          3       4
 *
 *  count 5        count 6          count 7
 *     L              L                L
 *   1   2          1   2            1   2
 *  3  4  5       3       4        3   4   5
 *                  5   6            6   7
 *
 *  - Count 1's lone escort sits centered one row back (a two-ship
 *    column; with one escort there is no triangle to have a top).
 *  - Count 3 is the leader-apex diamond: pair, then one centered in
 *    the 3-wide row. Count 5 fills that row (pair + full triple);
 *    count 7 adds a centered pair in the 4-wide row.
 *  - Counts 2 and 4 fly center-free flanking pairs — count 4 is the
 *    widening V from Paul's fork (escortPosition's hand-tuned 4-case).
 *  - Count 6 is the fork's other special case: three PAIRS with the
 *    middle column EMPTY (a hexagon). Filling the rows instead would
 *    park the sixth ship alone off-axis in the 4-wide row; the middle
 *    of the 3-wide row is skipped and the last pair tucks in behind.
 *  (Fork provenance: paul-npcs-era `escortPosition` special-cases 4
 *  and 6 exactly this way, and its base `triangleRaster` also starts
 *  rows at two cells — the leader-apex shape matches the fork's; the
 *  odd-count centered layouts here are new.)
 *
 * The layout is a function of (rank, count), NOT the persistent slot
 * number: slot ASSIGNMENT (hire order, continuation numbering) is
 * unchanged, but the formation-keeping systems convert a ship's slot
 * to its RANK among the live same-leader slots and pass the live
 * count. An escort joining or leaving therefore re-flows everyone to
 * the new count's layout — pure geometry, deterministic on every peer
 * (ranks come from sorting the synced slot numbers), and the RCS
 * controller slides ships the short hop to their new stations.
 */
export function formationOffset(rank: number,
    count?: number): { back: number, lateral: number } {
    // [row, lateral] in row/cell units, per rank, for counts 1-7.
    const SMALL_FORMATIONS: ReadonlyArray<
        ReadonlyArray<readonly [number, number]>> = [
            [],
            [[1, 0]],
            [[1, 0.5], [1, -0.5]],
            [[1, 0.5], [1, -0.5], [2, 0]],
            [[1, 0.5], [1, -0.5], [2, 1], [2, -1]],
            [[1, 0.5], [1, -0.5], [2, -1], [2, 0], [2, 1]],
            [[1, 0.5], [1, -0.5], [2, 1], [2, -1], [3, 0.5], [3, -0.5]],
            [[1, 0.5], [1, -0.5], [2, -1], [2, 0], [2, 1],
                [3, 0.5], [3, -0.5]],
        ];
    if (count !== undefined && count >= 1 && count <= 7 && rank < count) {
        const [row, lateralUnits] = SMALL_FORMATIONS[count][rank];
        return {
            back: row * FORMATION_ROW_SPACING,
            lateral: lateralUnits * FORMATION_LATERAL_SPACING,
        };
    }
    // General leader-apex triangle: row r (1-based) is (r + 1) cells
    // wide and holds ranks C(r-1) .. C(r)-1, where C(r) = r(r+3)/2 is
    // the cumulative capacity of rows 1..r.
    const row = Math.ceil((Math.sqrt(8 * rank + 17) - 3) / 2);
    const capacityBefore = ((row - 1) * (row + 2)) / 2;
    const indexInRow = rank - capacityBefore;
    // This row's occupancy: full (r + 1 cells) unless it is the
    // deepest, partially filled row of the formation.
    const occupancy = count === undefined ? row + 1
        : Math.min(row + 1, count - capacityBefore);
    // Occupants arranged center-out and symmetric for ANY occupancy:
    // odd k sits at 0, -1, +1, -2, +2, ...; even k at -0.5, +0.5,
    // -1.5, +1.5, ... (cell units).
    const oddRow = occupancy % 2 === 1;
    const pairIndex = oddRow
        ? Math.floor((indexInRow + 1) / 2) : Math.floor(indexInRow / 2) + 0.5;
    const side = (oddRow ? indexInRow : indexInRow + 1) % 2 === 1 ? -1 : 1;
    const lateralUnits = oddRow && indexInRow === 0 ? 0 : side * pairIndex;
    return {
        back: row * FORMATION_ROW_SPACING,
        lateral: lateralUnits * FORMATION_LATERAL_SPACING,
    };
}

/**
 * The world-space position of a leader's formation station for the
 * escort of the given RANK (see formationOffset) — pass the live
 * formation count for the per-count symmetric layouts.
 */
export function formationSlotPosition(leaderPosition: Position,
    leaderRotation: Angle, rank: number, count?: number): Position {
    const { back, lateral } = formationOffset(rank, count);
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
            // A bribe (hail beg-for-mercy) only lasts "until the player
            // provokes them again": if the briber is the one now shooting
            // us, the reprieve is void — clear it so NpcDecisionSystem stops
            // skipping them and resumes hostility.
            if (npc.pacifiedFrom === source) {
                npc.pacifiedFrom = undefined;
                npc.pacifiedUntil = undefined;
            }
        }
    },
});

// --- Decision making ---

const PlanetsQuery = new Query(
    [UUID, MovementStateComponent, PlanetComponent,
        PlanetDataComponent] as const);
const NpcTargetsQuery = new Query([UUID, MovementStateComponent, ShipComponent,
    ShipDataComponent, Optional(GovtComponent), Optional(ShieldComponent),
    Optional(CloakActiveComponent), Optional(DisabledComponent),
    Optional(LegalRecordsComponent)] as const);

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

/** A PlanetsQuery row: [uuid, movement, planet, planetData]. */
export type PlanetEntry = readonly [string, MovementState, unknown, PlanetData];

/**
 * The stellars NPCs treat as landing destinations / patrol homes. Wormholes
 * are excluded: they are transit portals, not places a ship parks (the player
 * can still deliberately fly into one to transit — that path is
 * AttemptLandingSystem, not the AI). Hidden the same way on every peer because
 * PlanetDataComponent is genesis state, so the AI stays deterministic.
 */
export function landingDestinations(planets: PlanetEntry[]): PlanetEntry[] {
    return planets.filter(([, , , data]) => data.gate?.kind !== 'wormhole');
}

/** Picks the next planet a trader heads for (uuid order for
 * determinism; Random for variety; excludes the one it's at). */
function pickPlanet(planets: PlanetEntry[],
    random: Random, exclude?: string): string | undefined {
    const ids = planets.map(([uuid]) => uuid)
        .filter(uuid => uuid !== exclude)
        .sort();
    if (ids.length === 0) {
        return undefined;
    }
    return ids[random.below(ids.length)];
}

function nearestPlanet(planets: PlanetEntry[],
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
        ShipDataComponent, Optional(FormationComponent),
        Optional(EscortCommandComponent), Optional(AssistingComponent),
        Optional(JumpComponent), NpcTargetsQuery,
        PlanetsQuery, TimeResource, RandomResource, Entities, UUID,
        SimulationGameDataResource] as const,
    step(npc, movement, target, govt, shield, shipData, formation,
        escortCommand, assisting, jump, ships, planets, time, random, entities,
        uuid, gameData) {
        if (escortCommand) {
            // A player-commanded escort: its brain is the escort
            // command framework (escort_command_plugin), not NPC AI.
            return;
        }
        if (assisting) {
            // A ship coming to the player's aid (hail request-assistance):
            // AssistBehaviorSystem owns its steering until it has helped.
            return;
        }
        if (npc.mode === 'depart') {
            return;
        }
        if (jump) {
            // Already warping out: the decision is made and the ship is
            // committed, so it must not talk itself back into a fight
            // (a warship in 'flee' would otherwise re-target and start
            // shooting from inside its own departure burn).
            //
            // SEQUENCE-NEUTRAL: this bails alongside the 'depart' bail,
            // above every draw site, and costs no draws that would
            // otherwise happen. The only unconditional draw is
            // rollDepartureTime below, and it has provably already
            // happened for any ship that is jumping: 'flee' and 'depart'
            // are only ever set further down this same step, past that
            // line. So no other NPC's roll shifts.
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
        // A bribe (hail beg-for-mercy) buys a reprieve: while it holds, the
        // briber is skipped as a hostile below and forgotten as an
        // aggressor; when it lapses, the ship resumes hunting a criminal.
        if (npc.pacifiedUntil !== undefined && time.time >= npc.pacifiedUntil) {
            npc.pacifiedFrom = undefined;
            npc.pacifiedUntil = undefined;
        }
        const pacifiedFrom = npc.pacifiedUntil !== undefined
            ? npc.pacifiedFrom : undefined;
        if (pacifiedFrom && npc.aggressor === pacifiedFrom) {
            npc.aggressor = undefined;
        }

        const position = Position.fromVectorLike(movement.position);
        const myStrength = effectiveStrength(
            shipData.strength, shieldFraction(shield));

        // Gather enemies: govt-hostile ships plus the recorded
        // aggressor. Cloaked ships are excluded (invisible to AI), and
        // so are DISABLED ships: a disabled ship is no longer a threat,
        // so warships and interceptors drop it and pick a new target
        // (boarding/piracy behavior is not modeled). Ships with legal
        // records (players) whose record with this govt is below its
        // crime tolerance are enemies too: crime has consequences.
        const hostiles: Array<readonly [string, number]> = [];
        let aggressorEntry: readonly [string, number, number] | undefined;
        for (const [otherUuid, otherMovement, , otherData, otherGovt,
            otherShield, cloak, otherDisabled, otherRecords] of ships) {
            if (otherUuid === uuid || !isTargetable(cloak) || otherDisabled) {
                continue;
            }
            if (otherUuid === pacifiedFrom) {
                // Bribed to leave this ship alone (reprieve still active).
                continue;
            }
            const distanceSquared = otherMovement.position
                .subtract(position).lengthSquared;
            const otherStrength = effectiveStrength(
                otherData.strength, shieldFraction(otherShield));
            if (otherUuid === npc.aggressor) {
                aggressorEntry = [otherUuid, distanceSquared, otherStrength];
            }
            const disposition = govtDispositionTo(govtData,
                lookupGovt(gameData, otherGovt), otherRecords);
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
                            landingDestinations(planets), random,
                            npc.destination);
                        npc.mode = npc.destination ? 'travel' : 'depart';
                    }
                }
                if (npc.mode === undefined) {
                    npc.destination = pickPlanet(
                        landingDestinations(planets), random);
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
                    npc.destination =
                        nearestPlanet(landingDestinations(planets), position);
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

/**
 * Hands a departing or fleeing NPC to the hyperspace jump sequence,
 * which owns it from here (NpcSteeringSystem bails while a
 * JumpComponent is present) until it warps out of the world.
 *
 * Returns false only when the ship CANNOT jump, which is the one case
 * the old delete-at-the-radius exit still has to cover. That is
 * exactly: the ship is disabled — dead in space, unable to turn onto a
 * jump heading or run its hyperdrive, the same reason PlayerJumpControl
 * refuses a disabled player. Nothing else can refuse: unlike a player's
 * jump this needs no route, no destination system data, and no fuel.
 * A ship disabled on its way out therefore keeps drifting and is
 * deleted at NPC_DEPART_RADIUS as before; if it is repaired first, it
 * jumps normally.
 *
 * This is the only disabled check the NPC jump path needs. A ship
 * disabled AFTER the sequence starts is handled by the general
 * disabled-cancels-jump rule (JumpDisableCancelSystem), which stops it
 * dead and takes the JumpComponent away; because 'depart' and 'flee'
 * re-run this on every tick they own the ship, a repair simply lands the
 * NPC back here and it starts a fresh sequence. There is nothing to
 * resume, and no resume logic.
 */
function departByJump(entity: Entity, movement: MovementState,
    physics: ShipPhysics, disabled: DisabledState | undefined): boolean {
    if (disabled) {
        return false;
    }
    beginDepartureJump(entity, movement, physics);
    return true;
}

/** Fly outward and report whether the ship has reached the radius at
 * which a ship that never managed to jump is removed anyway. */
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
 * Executes the NPC's current mode every tick. Departing and fleeing
 * ships hand themselves to the hyperspace jump sequence (see the module
 * comment); everything else steers here.
 */
export const NpcSteeringSystem = new System({
    name: 'NpcSteeringSystem',
    args: [NpcComponent, MovementStateComponent, ShipPhysicsComponent,
        TargetComponent, Optional(FormationComponent),
        Optional(EscortCommandComponent), Optional(EscortLandingComponent),
        Optional(DisabledComponent), Optional(JumpComponent),
        TimeResource, Entities, GetEntity, UUID] as const,
    step(npc, movement, physics, target, formation, escortCommand, landing,
        disabled, jump, time, entities, entity, uuid) {
        if (jump) {
            // Committed to the hyperspace jump: JumpSequenceSystem owns
            // this ship's controls until it leaves (it overrides them
            // anyway). A ship disabled mid-sequence is no exception here
            // any more: the general disabled-cancels-jump rule
            // (JumpDisableCancelSystem) has already taken the
            // JumpComponent away before this system runs, so a disabled
            // ship never reaches this branch at all. If it is repaired
            // later it falls through to the mode switch below and decides
            // to depart afresh, starting a whole new sequence.
            return;
        }
        if (landing) {
            // Following the player down to a planet (player_escort_plugin
            // steers this ship). Checked before the escort-command bail so
            // an escort without command state still yields.
            return;
        }
        if (escortCommand) {
            return; // Player-commanded: see escort_command_plugin.
        }
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
                // Far enough from the center to jump: start the jump
                // sequence (same exit as 'depart') — unless the chaser
                // is right behind (see chaserBlocksJump). The decision
                // is unchanged; only the exit is, so a fleeing ship is
                // now seen to align and warp out rather than blink away
                // — and it stays shootable, and interruptible by being
                // disabled, for the length of the sequence.
                if (movement.position.length > JUMP_DISTANCE
                    && !(aggressor
                        && chaserBlocksJump(movement, aggressor))
                    && departByJump(entity, movement, physics, disabled)) {
                    break;
                }
                // Run from the attacker; with no attacker position,
                // run outward from the system center.
                const away = aggressor
                    ? movement.position.subtract(aggressor.position)
                    : new Vector(movement.position.x, movement.position.y);
                // At the depart radius the ship is off the edge of the
                // playfield, so a chaser on its tail no longer holds it
                // here: it jumps anyway, and is deleted outright only if
                // it cannot (disabled). See departByJump.
                if (steerOutward(movement, away)
                    && !departByJump(entity, movement, physics, disabled)) {
                    entities.delete(uuid);
                }
                break;
            }
            case 'depart': {
                // Fly outward until clear of the no-jump zone (the same
                // threshold the flee exit uses), then jump out.
                if (movement.position.length > JUMP_DISTANCE
                    && departByJump(entity, movement, physics, disabled)) {
                    break;
                }
                const away = new Vector(
                    movement.position.x, movement.position.y);
                // Only a ship that could not jump at all reaches the
                // depart radius (it is well outside the no-jump zone, so
                // the branch above already tried and was refused): the
                // old delete-at-the-edge exit, now the disabled-ship
                // fallback. See departByJump.
                if (steerOutward(movement, away)) {
                    entities.delete(uuid);
                }
                break;
            }
        }
    },
    after: [TimeSystem, NpcDecisionSystem],
    // Explicit edge rather than a toposort accident: a ship that decides
    // to leave this tick enters the sequence and starts stopping on the
    // same tick, and the ordering is stable across a snapshot restore
    // (determinism rule 4). The reverse edge would be a cycle via
    // DisabledMovementSystem, which is after both.
    before: [MovementSystem, JumpSequenceSystem],
});

/**
 * Fires every weapon at the NPC's target while attacking and in range;
 * ceases fire otherwise.
 *
 * BAYS INCLUDED: a bay's ammo is its fighters (weapon_parse's
 * AmmoTypeParse), so the magazine bounds the total and the reload clock
 * paces the launches. No separate "has a target" gate is needed here —
 * `inRange` is already false unless the NPC is in attack mode with a
 * LIVE target entity, so an idle carrier never opens its hangar.
 * Launched fighters are pointed at the carrier's victim by
 * NpcWingCommandSystem (escort_command_plugin).
 *
 * A SHIP IN A JUMP SEQUENCE HOLDS ITS FIRE. NpcDecisionSystem bails on a
 * jumping ship so it cannot talk itself back into a fight, but bailing
 * PRESERVES the mode and target it was carrying when the sequence began —
 * so a ship already in 'attack' with a live victim goes on firing all
 * through its stop, its turn, its spin-up and its departure burn. That is
 * exactly the opposite of the "committed, so it disengages" the visible
 * sequence exists to show.
 *
 * WHO ACTUALLY REACHES THAT STATE. Not the NPC departure path:
 * departByJump is called from NpcSteeringSystem's 'flee' and 'depart'
 * arms, so the mode at the moment beginDepartureJump attaches the
 * component is structurally never 'attack'. The reachable case is a
 * FOLLOW jump. sweepableEscorts keys on the flock chain, not on
 * EscortCommandComponent, so an NPC FLEET ESCORT whose leader the player
 * captured (convertToEscort re-parents the leader onto the player; the
 * leader's own fleet escorts keep formation on it and are marked as the
 * player's) is swept into beginFollowJump while still running its own NPC
 * AI — including 'attack' with a live target, since it has no escort
 * command to make NpcDecisionSystem yield. Hired escorts, bay fighters
 * and mission ships all avoid it for their own reasons; this one does not.
 *
 * GATED, NOT CLEARED. The ship keeps its mode and target and simply does
 * not shoot while the JumpComponent is there; the weapons are released
 * (`firing = false`) on the tick the gate takes effect, which is what
 * stops a beam or a stream weapon that was already firing. Clearing the
 * target instead would be a one-way door: a sequence CANCELLED by a
 * disable (JumpDisableCancelSystem deletes the JumpComponent) would leave
 * the repaired ship blank and unable to defend itself until its next
 * think tick. With the gate, the same ship resumes firing on the very
 * tick the component goes, at the target it already had.
 */
const NpcFireControlSystem = new System({
    name: 'NpcFireControlSystem',
    args: [NpcComponent, WeaponsStateComponent, TargetComponent,
        MovementStateComponent, Optional(JumpComponent), Entities,
        SimulationGameDataResource,
        Optional(EscortCommandComponent)] as const,
    step(npc, weapons, target, movement, jump, entities, gameData,
        escortCommand) {
        if (escortCommand) {
            // A player-commanded escort: the escort command framework
            // (escort_command_plugin) owns its TRIGGERS as well as its
            // steering. The other two halves of this AI already yield
            // to it — NpcDecisionSystem and NpcSteeringSystem both bail
            // on EscortCommandComponent — and fire control not doing so
            // was Matthew's "escorts sometimes don't fire when
            // commanded; they just circle the enemy" playtest report.
            //
            // THE MECHANISM. Because NpcDecisionSystem bails, a
            // commanded escort's `npc.mode` is never 'attack', so
            // `inRange` below is always false and this system used to
            // clear `firing` on EVERY weapon of EVERY escort that has an
            // NpcComponent — while EscortCommandBehaviorSystem set those
            // very same flags in the same tick. Neither system ordered
            // itself against the other, and this one runs later, so its
            // cease-fire was the write that survived into the latched
            // state WeaponsSystem reads.
            //
            // WHY IT LOOKED INTERMITTENT RATHER THAN TOTAL. Not
            // flakiness — system order is deterministic
            // (topologicalSortList is a stable function of registration
            // order), so an affected escort NEVER fired. What varied was
            // WHICH ESCORT, because only some kinds carry NpcComponent
            // at all:
            //   - hired escorts (spawnHiredEscorts -> makeNpcShip) and
            //     captured prizes (convertToEscort keeps the NPC brain,
            //     only clearing mode/aggressor) HAVE it -> silent;
            //   - bay-launched fighters do NOT (bay_plugin builds them
            //     with makeShip) -> they fired correctly all along.
            // So the same player, in the same session, saw some escorts
            // shoot and others just circle.
            //
            // STEERING NEVER SHOWED IT: EscortCommandBehaviorSystem is
            // the only writer of a commanded escort's movement, so the
            // ship orbited its victim at standoff exactly as ordered
            // while its guns stayed cold — the reported symptom.
            //
            // Bailing (rather than ordering the two systems) is what
            // keeps ALL of the escort framework's firing decisions
            // intact, not just the attack case: hold-fire while
            // landing/jumping, holdPosition's cease-fire, and the
            // formation-time front-quadrant-turret rule are equally
            // this system's to leave alone.
            //
            // NPC-CARRIER WINGS ARE COVERED, NOT ORPHANED. A bay fighter
            // launched by an NPC carrier carries EscortCommandComponent
            // too, and NpcWingCommandSystem mirrors the carrier's victim
            // onto it as an 'attack' command; EscortCommandBehaviorSystem
            // then fires its weapons. So the wings that reach this bail
            // have a live trigger-owner either way.
            return;
        }
        if (jump) {
            // Committed to leaving: cease fire for the whole sequence.
            // Falling through with `inRange` false would do the same, but
            // saying it here keeps the reason legible and skips the range
            // math for a ship that is not allowed to shoot regardless.
            for (const [, weapon] of weapons) {
                weapon.firing = false;
            }
            return;
        }
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
            if (weaponType == null) {
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
 * Steers a follower toward its slot. Two regimes with hysteresis
 * (state in formation.rcs):
 *
 *  - Large correction (above RCS_DISENGAGE_SPEED, or above
 *    RCS_ENGAGE_SPEED when not yet on RCS): the classic turn-and-burn
 *    — point at the correction and use the main engine.
 *  - Small correction: RCS station-keeping — a velocity nudge budgeted
 *    at RCS_ACCEL_FRACTION of the ship's main acceleration, applied
 *    directly with NO rotation and NO `accelerating` (so no engine
 *    flare); the ship holds its heading on the leader's.
 *
 * The correction is the desired velocity (leader's, plus a
 * proportional pull toward the slot) minus the follower's. Pure so
 * tests can check convergence and that RCS never turns the ship.
 */
export function steerFormation(movement: MovementState, leader: MovementState,
    formation: Formation, acceleration: number, delta_s: number,
    rank = formation.slot, count?: number): void {
    const slotPosition = formationSlotPosition(
        Position.fromVectorLike(leader.position),
        Angle.fromAngleLike(leader.rotation), rank, count);
    const lead = Vector.fromVectorLike(leader.velocity)
        .scale(FORMATION_LOOKAHEAD_S);
    const error = slotPosition.add(lead).subtract(movement.position);
    // Desired velocity: the leader's, plus a correction proportional
    // to the position error.
    const desired = Vector.fromVectorLike(leader.velocity)
        .add(error.scale(FORMATION_POSITION_GAIN));
    const correction = desired.subtract(movement.velocity);

    // Hysteresis: engage RCS below the low threshold, drop it above
    // the high one, keep the previous regime in between.
    const magnitude = correction.length;
    if (formation.rcs) {
        if (magnitude > RCS_DISENGAGE_SPEED) {
            formation.rcs = false;
        }
    } else if (magnitude < RCS_ENGAGE_SPEED) {
        formation.rcs = true;
    }

    if (formation.rcs) {
        // RCS station-keeping: nudge velocity toward desired, capped
        // by this tick's RCS budget; never rotate, never light the
        // main engine. Replaces (does not mutate) the velocity object
        // per the movement contract.
        const budget = acceleration * RCS_ACCEL_FRACTION * delta_s;
        const nudge = magnitude <= budget
            ? correction : correction.normalize(budget);
        movement.velocity = Vector.fromVectorLike(movement.velocity)
            .add(nudge);
        movement.accelerating = 0;
        movement.turnBack = false;
        movement.turnTo = Angle.fromAngleLike(leader.rotation);
        return;
    }

    // Turn-and-burn: point at the correction, main engine when
    // roughly aligned.
    const heading = correction.angle;
    movement.turnTo = heading;
    movement.turnBack = false;
    const misalignment = movement.rotation.distanceTo(heading).angle;
    movement.accelerating = Math.abs(misalignment) < 0.7 ? 1 : 0;
}

export const AllFormationsQuery = new Query([FormationComponent] as const);

export const FormationSystem = new System({
    name: 'FormationSystem',
    args: [FormationComponent, MovementStateComponent, ShipPhysicsComponent,
        Optional(NpcComponent), Optional(EscortCommandComponent),
        Optional(EscortLandingComponent), Optional(JumpComponent),
        AllFormationsQuery, TimeResource, Entities, GetEntity,
        UUID] as const,
    step(formation, movement, physics, npc, escortCommand, landing, jump,
        allFormations, time, entities, entity) {
        if (landing) {
            // Following the player down to a planet: EscortLandingSystem
            // owns this ship's steering until it lands.
            return;
        }
        if (jump) {
            // Committed to a hyperspace jump — an escort warping out with
            // its player, or a formation leader of its own doing so.
            // JumpSequenceSystem owns the steering until the ship leaves.
            // Station-keeping must not run alongside it: the RCS regime
            // nudges velocity DIRECTLY, so ordering alone would not stop a
            // ship that is supposed to be holding still for its spin-up
            // from creeping toward its slot. Same bail NpcSteeringSystem
            // takes, for the same reason.
            return;
        }
        // Engaged escorts fight; FormationSystem only holds station.
        if (npc && !escortCommand && (npc.mode === 'attack'
            || npc.mode === 'flee' || npc.mode === 'depart')) {
            return;
        }
        // Player-commanded escorts: station-keep only while the
        // command is formation (or defend with no intruder engaged) —
        // the command behavior system steers everything else.
        if (escortCommand && !(escortCommand.command === 'formation'
            || (escortCommand.command === 'defend'
                && escortCommand.target === undefined))) {
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
        // Rank + live count drive the per-count symmetric layouts:
        // the ship's persistent slot number is only an ORDER; its
        // station comes from its rank among the live same-leader
        // slots. Deterministic (sorting synced slot numbers) and
        // cheap (formations are tiny); an escort joining or leaving
        // re-flows the rest to the new count's layout.
        const siblingSlots = allFormations
            .filter(([other]) => other.leader === formation.leader)
            .map(([other]) => other.slot)
            .sort((a, b) => a - b);
        const rank = siblingSlots.indexOf(formation.slot);
        // Base acceleration (not the per-tick effective physics):
        // afterburners must not boost the RCS budget.
        steerFormation(movement, leader, formation,
            physics.acceleration, time.delta_s,
            rank < 0 ? formation.slot : rank, siblingSlots.length);
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
