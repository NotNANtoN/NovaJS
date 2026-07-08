import * as t from 'io-ts';
import { JammingStrengths } from 'novadatainterface/outfit_data';
import { SeekerFlags, JammingVulnerabilities } from 'novadatainterface/weapon_data';
import { Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Position } from 'nova_ecs/datatypes/position';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { EntityMap } from 'nova_ecs/entity_map';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Optional } from 'nova_ecs/optional';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { RandomResource } from 'nova_ecs/plugins/random_plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { registerEntityDeriver } from './entity_factory.js';
import { Govt, GovtComponent } from './govt_component.js';
import { OutfitsState, OutfitsStateComponent } from './outfit_plugin.js';
import { ProjectileDataComponent } from './projectile_data.js';
import { ProvideFromCache } from './provide_from_cache.js';
import { OwnerComponent, SourceComponent } from './fire_weapon_plugin.js';
import { TargetComponent } from './target_component.js';

/**
 * ============================================================================
 * Missile jamming (EVN Bible model vs. what we implement)
 * ============================================================================
 *
 * The Bible describes the *fields* but is vague on the exact per-frame math, so
 * where it is silent we pick a reasonable, data-driven model and document it
 * here.
 *
 * Bible fields (all plumbed through the data layer):
 *  - wëap JamVuln1-4: a guided weapon's vulnerability to each of the four
 *    jamming types (0-100%). "Ignored if the weapon is not a guided weapon."
 *  - oütf ModTypes 33-36 ("Jamming Type 1-4"): jamming strength an outfit adds
 *    to its ship (percent, can be negative), summed across outfits.
 *  - govt InhJam1-4: a government's inherent jamming. A ship that carries a
 *    GovtComponent folds its government's InhJam1-4 into its jamming; see
 *    deriveJamming and the InhJam composition rule documented there. Ships with
 *    no GovtComponent (e.g. the player, or NPCs before government-aware spawning
 *    exists) get their jamming purely from outfits, unchanged.
 *  - sÿst Interference: system sensor static (0-100), which additionally
 *    degrades radar-guided missiles (Seeker flag 0x0008, confusedByInterference).
 *  - Seeker flags: turnsAwayIfJammed (0x0010), attackParentIfJammed (0x8000),
 *    decoyedByAsteroids (0x0002), confusedByInterference (0x0008).
 *
 * OUR MODEL (per frame, per jammed missile), all magnitudes data-driven:
 *
 *  1. Effective jamming strength the missile experiences for type `k` is
 *         effJam_k = clamp(targetShipJamming_k, 0, 100)
 *     plus, only for the radar type (k = 1, 0-indexed) and only when the
 *     weapon's Seeker `confusedByInterference` flag is set, the current
 *     system's Interference value (see judgment call #3).
 *
 *  2. Per-type per-frame lose-lock probability is the product of the missile's
 *     vulnerability and the effective jamming for that type:
 *         p_k = (vuln_k / 100) * (effJam_k / 100)
 *     The four types are independent, so the frame's overall lose-lock chance is
 *         pLose = 1 - Π_k (1 - p_k)
 *     This is scaled by JAM_FRAME_RATE so the *per-second* aggression is stable
 *     regardless of the 60 Hz tick (see JAM_FRAME_RATE).
 *
 *  3. A single deterministic PRNG draw decides whether the missile loses lock
 *     this frame. On a lose-lock result, the missile reacts per its Seeker
 *     flags:
 *       - attackParentIfJammed: retarget the ship that fired it (if known).
 *       - turnsAwayIfJammed: mark it to veer away from its target this frame.
 *       - otherwise: drop guidance for the frame (fly straight ahead).
 *
 * A missile only ever loses lock; it does not spontaneously re-acquire (the
 * original target reference is kept unless it retargets a decoy or its parent),
 * which keeps behaviour legible and matches the "loses lock / veers off"
 * language in the Bible.
 */

/**
 * The per-frame jamming is scaled by this factor so the *aggregate* jamming
 * pressure is expressed per (1/30 s) "Nova frame" rather than per 60 Hz
 * simulation tick. Nova's own timings are in 30ths of a second, and the sim
 * runs at 60 Hz, so a raw per-tick roll would jam twice as fast as the data
 * intends. JUDGMENT CALL: the Bible gives no per-frame rate, so we anchor the
 * probability to Nova's 30 Hz frame and split it across the two sim ticks that
 * make up one Nova frame.
 */
export const JAM_FRAME_RATE = 0.5;

/**
 * A ship's accumulated jamming strength for each of the four jamming types,
 * derived from its outfits (oütf ModTypes 33-36). Percentages that add across
 * outfits; clamped to be non-negative when applied against missiles.
 *
 * Ordered [type1, type2, type3, type4] to match weapon JamVulnerabilities.
 */
export const Jamming = t.tuple([t.number, t.number, t.number, t.number]);
export type Jamming = t.TypeOf<typeof Jamming>;
export const JammingComponent = new Component<Jamming>('JammingComponent');

/**
 * The current system's inherent sensor interference (0-100), read from
 * SystemData.interference. Set once at world construction (make_system.ts) so it
 * is identical for every peer in a room, satisfying rollback determinism.
 */
export const SystemInterferenceResource =
    new Resource<{ interference: number }>('SystemInterference');

/**
 * Decoy hook for the asteroid agent (and any other distraction source).
 *
 * Attach this component to any entity that a jammed, `decoyedByAsteroids`
 * missile may be lured onto. The entity MUST also carry a
 * MovementStateComponent (so the missile has a position to steer toward). When
 * a missile loses lock and its weapon has the `decoyedByAsteroids` seeker flag,
 * the retarget system may switch the missile's TargetComponent to a nearby
 * decoy instead of applying the veer/straight-fly behaviour.
 *
 * `weight` biases selection: higher-weight decoys are more attractive. Use 1
 * for a plain decoy. (Asteroids can set this to model bigger rocks being more
 * distracting; leave it at 1 if you don't care.)
 *
 * CONTRACT FOR THE ASTEROID AGENT: to make asteroids able to distract jammed
 * missiles, attach `DecoyTargetComponent` (e.g. `{ weight: 1 }`) plus a
 * `MovementStateComponent` to each asteroid entity. No other wiring is needed;
 * this plugin discovers decoys by querying for the component.
 */
export const DecoyTargetComponent =
    new Component<{ weight: number }>('DecoyTargetComponent');

/**
 * The radius within which a jammed, decoy-vulnerable missile can be distracted
 * onto a decoy. JUDGMENT CALL: the Bible does not specify a range, so we use a
 * generous fixed radius in world units. Kept as a named constant so it is easy
 * to tune or make data-driven later.
 */
export const DECOY_DISTRACTION_RANGE = 1000;
const DECOY_DISTRACTION_RANGE_SQUARED =
    DECOY_DISTRACTION_RANGE * DECOY_DISTRACTION_RANGE;

/** The index of the radar jamming type (0-based) in the 4-tuple. */
export const RADAR_JAM_INDEX = 1;

/**
 * Folds a government's inherent jamming (govt InhJam1-4) into a ship's
 * outfit-derived jamming, per type.
 *
 * INHJAM COMPOSITION RULE (JUDGMENT CALL): the EVN Bible describes InhJam1-4 as
 * the government's inherent jamming *ability* (a 0-100% value) but does not say
 * how it combines with outfit jamming (oütf ModTypes 33-36, which add across
 * hardware). We take the per-type MAX rather than a sum: a government's inherent
 * sensor tech is a floor, not another piece of bolt-on hardware, so a ship of a
 * high-jamming government (e.g. the Krypt at InhJam 100) is not pushed past 100
 * just by also carrying a jammer, and a ship whose outfits already out-jam its
 * government keeps the stronger outfit value. Outfit sums can be negative (a
 * "jamming" outfit with a negative ModType), so the max also prevents a negative
 * outfit total from cancelling a government's inherent jamming below its floor.
 *
 * Not modelled yet (deferred to NPC/AiType work): the gövt
 * `freightersHalfJamming` flag, under which AiType 1-2 freighters get 50% of the
 * warship InhJam value. Ships have no AiType in the sim yet, so every
 * govt-carrying ship is treated as getting the full warship InhJam.
 */
function foldInhJam(outfitJamming: readonly [number, number, number, number],
    inhJam: readonly [number, number, number, number]):
    [number, number, number, number] {
    return [
        Math.max(outfitJamming[0], inhJam[0] ?? 0),
        Math.max(outfitJamming[1], inhJam[1] ?? 0),
        Math.max(outfitJamming[2], inhJam[2] ?? 0),
        Math.max(outfitJamming[3], inhJam[3] ?? 0),
    ];
}

/**
 * Derives a ship's jamming: sums the per-type strength contributed by its
 * outfits (oütf ModTypes 33-36), then, if a government id is given, folds that
 * government's inherent jamming (govt InhJam1-4) in per type via foldInhJam.
 * Pure and deterministic; returns a fresh 4-tuple.
 *
 * Returns undefined (retry next step, matching deriveWeaponsState) if any
 * outfit -- or the given government -- is not yet in the game-data cache.
 */
export function deriveJamming(outfits: OutfitsState,
    gameData: SimulationGameDataInterface,
    govtId?: string): Jamming | undefined {
    const total: [number, number, number, number] = [0, 0, 0, 0];
    for (const [id, state] of outfits) {
        const outfit = gameData.data.Outfit.getCached(id);
        if (!outfit) {
            // Not loaded yet; retry next step (matches deriveWeaponsState).
            return undefined;
        }
        for (let i = 0; i < 4; i++) {
            total[i] += (outfit.jamming[i] ?? 0) * state.count;
        }
    }
    if (govtId === undefined) {
        return total;
    }
    const govt = gameData.data.Govt.getCached(govtId);
    if (!govt) {
        // Government data not loaded yet; retry next step.
        return undefined;
    }
    return foldInhJam(total, govt.inhJam);
}

/**
 * Computes the effective jamming strength (0-100 per type) a missile
 * experiences, combining the target ship's jamming with system interference for
 * radar-guided missiles. Pure; does not roll.
 */
export function effectiveJamming(
    targetJamming: JammingStrengths | Jamming | undefined,
    seeker: SeekerFlags,
    systemInterference: number): [number, number, number, number] {
    const jam: [number, number, number, number] = [
        Math.max(0, targetJamming?.[0] ?? 0),
        Math.max(0, targetJamming?.[1] ?? 0),
        Math.max(0, targetJamming?.[2] ?? 0),
        Math.max(0, targetJamming?.[3] ?? 0),
    ];
    // Radar-guided missiles flagged confusedByInterference are additionally
    // degraded by the system's inherent sensor static, as a radar-type
    // contribution. (Judgment call #3: the Bible ties interference to the radar
    // display and to this seeker flag but doesn't give a formula, so we fold it
    // in as extra radar jamming.)
    if (seeker.confusedByInterference) {
        jam[RADAR_JAM_INDEX] += Math.max(0, systemInterference);
    }
    for (let i = 0; i < 4; i++) {
        jam[i] = Math.min(100, jam[i]);
    }
    return jam;
}

/**
 * The per-frame probability that a missile with the given vulnerabilities loses
 * lock, given the effective jamming it experiences. Pure; does not roll.
 *
 * Each jamming type independently contributes p_k = vuln_k * effJam_k (as
 * fractions); the combined lose chance is 1 - Π(1 - p_k), scaled by
 * JAM_FRAME_RATE to normalize per-tick aggression to Nova's 30 Hz frame.
 */
export function jamLoseLockProbability(
    vulnerabilities: JammingVulnerabilities,
    effectiveJam: readonly [number, number, number, number]): number {
    let keep = 1;
    for (let i = 0; i < 4; i++) {
        const vuln = Math.max(0, Math.min(100, vulnerabilities[i] ?? 0)) / 100;
        const jam = Math.max(0, Math.min(100, effectiveJam[i] ?? 0)) / 100;
        keep *= (1 - vuln * jam);
    }
    return (1 - keep) * JAM_FRAME_RATE;
}

/**
 * How a jammed missile should react this frame. Returned by the pure decision
 * helper so it can be unit-tested without an ECS world.
 */
export type JamReaction =
    | { kind: 'none' }                       // not jammed this frame
    | { kind: 'retargetParent' }             // attackParentIfJammed
    | { kind: 'retargetDecoy' }              // decoyedByAsteroids (caller finds decoy)
    | { kind: 'veerAway' }                   // turnsAwayIfJammed
    | { kind: 'flyStraight' };               // default lost-lock behaviour

/**
 * Decides, deterministically, whether and how a missile loses lock this frame.
 * `roll` must be a fresh draw from the deterministic PRNG in [0, 1).
 *
 * The precedence for the reaction when jammed is:
 *   attackParentIfJammed > decoyedByAsteroids > turnsAwayIfJammed > flyStraight
 * (The caller is responsible for finding a decoy for `retargetDecoy`; if none is
 * nearby it should fall back to veer/straight, so decoy vulnerability never
 * makes a missile *more* accurate.)
 */
export function decideJamReaction(
    probability: number, roll: number, seeker: SeekerFlags): JamReaction {
    if (roll >= probability) {
        return { kind: 'none' };
    }
    if (seeker.attackParentIfJammed) {
        return { kind: 'retargetParent' };
    }
    if (seeker.decoyedByAsteroids) {
        return { kind: 'retargetDecoy' };
    }
    if (seeker.turnsAwayIfJammed) {
        return { kind: 'veerAway' };
    }
    return { kind: 'flyStraight' };
}

/**
 * Finds the best decoy entity within range of a position, deterministically.
 * "Best" = highest weight, ties broken by smallest distance, then by uuid for a
 * total order (so resimulation always picks the same decoy). Returns the decoy
 * uuid or undefined.
 */
export function findNearestDecoy(entities: Iterable<[string, Entity]>,
    from: Position): string | undefined {
    let bestId: string | undefined;
    let bestWeight = -Infinity;
    let bestDistSq = Infinity;
    for (const [id, entity] of entities) {
        const decoy = entity.components.get(DecoyTargetComponent);
        if (!decoy) {
            continue;
        }
        const movement = entity.components.get(MovementStateComponent);
        if (!movement) {
            continue;
        }
        // Position.subtract wraps around the toroidal ±BOUNDARY world, so this
        // is the true shortest-path distance (matching how point defense picks
        // its nearest target).
        const distSq = movement.position.subtract(from).lengthSquared;
        if (distSq > DECOY_DISTRACTION_RANGE_SQUARED) {
            continue;
        }
        const weight = decoy.weight;
        const better = weight > bestWeight
            || (weight === bestWeight && distSq < bestDistSq)
            || (weight === bestWeight && distSq === bestDistSq
                && (bestId === undefined || id < bestId));
        if (better) {
            bestId = id;
            bestWeight = weight;
            bestDistSq = distSq;
        }
    }
    return bestId;
}

/**
 * Transient per-frame steering override for a jammed missile, consumed by the
 * guidance system the same tick it is set. It is recomputed every frame by
 * MissileJammingSystem, so it is intentionally NOT part of any snapshot (a
 * restore re-runs the jamming system before guidance).
 *
 * - `veerAway`: steer away from the target instead of toward it.
 * - `flyStraight`: ignore the target and keep the current heading.
 */
export type JamSteer = 'veerAway' | 'flyStraight';
export const JamSteerComponent = new Component<JamSteer>('JamSteerComponent');

/**
 * Live provider: keeps a ship's JammingComponent in sync as its outfits change.
 * Mirrors OutfitWeaponProvider in outfit_plugin.ts.
 */
const JammingProvider = ProvideFromCache({
    name: 'JammingProvider',
    provided: JammingComponent,
    // Re-derive when the outfits change or the ship's government is set/changed.
    update: [OutfitsStateComponent, GovtComponent],
    args: [OutfitsStateComponent, Optional(GovtComponent),
        SimulationGameDataResource] as const,
    factory: (outfits, govt, gameData) =>
        deriveJamming(outfits, gameData, govt?.id),
});

/**
 * Applies missile jamming to guided projectiles. Runs before
 * ProjectileGuidanceSystem so that a jammed missile's target/veer state is set
 * before the guidance angle is computed.
 *
 * Deterministic: a single PRNG draw per guided missile per frame, in the ECS's
 * stable system-iteration order (the same pattern as weapon inaccuracy).
 */
export const MissileJammingSystem = new System({
    name: 'MissileJammingSystem',
    args: [MovementStateComponent, TargetComponent, ProjectileDataComponent,
        GetEntity, UUID, Entities, RandomResource, SystemInterferenceResource,
        ] as const,
    step(movement, targetRef, projectileData, self, uuid, entities, random,
        systemInterference) {
        // Clear last frame's steer override up front so it never lingers.
        self.components.delete(JamSteerComponent);

        // Only guided missiles with a target can be jammed. Vulnerabilities are
        // "ignored if the weapon is not a guided weapon" (Bible).
        if (projectileData.guidance !== 'guided') {
            return;
        }
        const target = targetRef.target;
        if (!target) {
            return;
        }
        const seeker = projectileData.seeker;

        const targetEntity = entities.get(target);
        const targetJamming = targetEntity?.components.get(JammingComponent);

        const effJam = effectiveJamming(targetJamming, seeker,
            systemInterference.interference);
        const probability = jamLoseLockProbability(
            projectileData.jamVulnerabilities, effJam);
        // Draw exactly once per missile per frame for determinism, even if
        // probability is 0 (so the PRNG sequence is independent of jamming
        // state -- adding/removing a jammer never shifts other missiles' rolls
        // for a given tick). Guard the common no-jam case after the draw.
        const roll = random.next();
        if (probability <= 0) {
            return;
        }

        const reaction = decideJamReaction(probability, roll, seeker);
        applyJamReaction(reaction, self, uuid, movement, entities);
    }
});

/**
 * Mutates the missile according to the chosen reaction. Kept separate so the
 * decision stays pure and testable.
 */
export function applyJamReaction(reaction: JamReaction, self: Entity,
    uuid: string, movement: { position: Position },
    entities: EntityMap) {
    switch (reaction.kind) {
        case 'none':
            return;
        case 'retargetParent': {
            const source = self.components.get(SourceComponent);
            const owner = self.components.get(OwnerComponent)?.owner;
            const parent = source ?? owner;
            if (parent && parent !== uuid) {
                self.components.set(TargetComponent, { target: parent });
            } else {
                self.components.set(JamSteerComponent, 'veerAway');
            }
            return;
        }
        case 'retargetDecoy': {
            const decoy = findNearestDecoy(entities, movement.position);
            if (decoy) {
                self.components.set(TargetComponent, { target: decoy });
            } else {
                // No decoy in range: don't reward the missile with better aim.
                self.components.set(JamSteerComponent, 'veerAway');
            }
            return;
        }
        case 'veerAway':
            self.components.set(JamSteerComponent, 'veerAway');
            return;
        case 'flyStraight':
            self.components.set(JamSteerComponent, 'flyStraight');
            return;
    }
}

export const JammingPlugin: Plugin = {
    name: 'JammingPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }

        world.addComponent(JammingComponent);
        deltaMaker.addComponent(JammingComponent, {
            componentType: Jamming,
        });

        // A ship's government (optional; set by future NPC spawning). Registered
        // for the delta/serializer so it replicates and survives snapshots; it's
        // a plain { id } object, so the default codec/snapshot policy suffice.
        // Registered here because JammingPlugin is its only consumer so far.
        world.addComponent(GovtComponent);
        deltaMaker.addComponent(GovtComponent, {
            componentType: Govt,
        });

        // Default to no interference; make_system.ts overrides this with the
        // current system's SystemData.interference. Defaulting here keeps the
        // MissileJammingSystem's required resource satisfied in any world that
        // installs this plugin (e.g. unit-test worlds).
        if (!world.resources.has(SystemInterferenceResource)) {
            world.resources.set(SystemInterferenceResource, { interference: 0 });
        }

        // Re-derive a ship's jamming from its outfits (and its government's
        // InhJam, if it has a GovtComponent) at completeEntity / snapshot
        // restore (mirrors WeaponsStateDeriver). GovtComponent is optional, so
        // it is not in `requires`; when absent, jamming is outfit-only.
        registerEntityDeriver(world, {
            name: 'JammingDeriver',
            provided: JammingComponent,
            requires: [OutfitsStateComponent],
            derive: (entity, gameData) => deriveJamming(
                entity.components.get(OutfitsStateComponent)!, gameData,
                entity.components.get(GovtComponent)?.id),
        });
        world.addSystem(JammingProvider);
        world.addSystem(MissileJammingSystem);
    }
};
