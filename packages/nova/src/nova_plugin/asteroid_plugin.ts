import * as t from 'io-ts';
import { AsteroidData } from 'novadatainterface/asteroid_data';
import { Emit, Entities, RunQuery, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position, PositionType } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { EntityMap } from 'nova_ecs/entity_map';
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementState, MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Random, RandomResource } from 'nova_ecs/plugins/random_plugin';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { TimeResource, TimeSystem } from 'nova_ecs/plugins/time_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { World } from 'nova_ecs/world';
import SAT from 'sat';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { registerSimulationBridgeEvent } from '../communication/simulation_bridge_events.js';
import { AnimationComponent } from './animation_plugin.js';
import { BeamDataComponent } from './beam_plugin.js';
import { CargoComponent, cargoUsed } from './cargo_plugin.js';
import { CollisionEvent, CollisionHitterComponent, CollisionVulnerabilityComponent } from './collision_interaction.js';
import { CompositeHull, HitboxHullComponent, HurtboxHullComponent, UpdateHitboxHullSystem, UpdateHurtboxHullSystem } from './collisions_plugin.js';
import { DamagedEvent } from './death_plugin.js';
import { registerEntityDeriver } from './entity_factory.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { IdFactory, IdFactoryResource } from './id_factory.js';
import { DecoyTargetComponent } from './jamming_plugin.js';
import { OutfitsStateComponent } from './outfit_plugin.js';
import { ProjectileDataComponent } from './projectile_data.js';
import { ShipPhysicsComponent } from './ship_plugin.js';

/**
 * The asteroid field is a square of this half-size centered on the
 * origin, where the system's planets and ship spawns live. The original
 * engine keeps the system's asteroid count drifting within the visible
 * screen and wraps them around its edges (a per-screen density, not a
 * total); a shared deterministic simulation can't have per-player
 * asteroids, so instead the field covers the region gameplay happens in
 * at the same per-screen density, and asteroids wrap at its edges.
 */
export const ASTEROID_FIELD_HALF_SIZE = 3000;
/**
 * The screen area the original engine's per-screen asteroid count
 * refers to (a 1024x768 game window, roughly).
 */
const REFERENCE_SCREEN_AREA = 1024 * 768;
/**
 * Density cap. The sÿst Asteroids field is a per-screen density (0-16);
 * the field is (2*3000)^2 / (1024*768) ≈ 45.8 screens, so the demanded
 * total is count * 45.8: Fomalhaut (nova:136, count 2) demands ~92 and
 * the densest systems (count 10, e.g. S7evyn nova:472) demand ~458.
 * Measured on an M2 laptop (node, real Nova data): Fomalhaut's 92
 * asteroids cost 0.09 ms/step of simulation plus 0.31 ms/frame of
 * sim->display snapshot encoding; an uncapped S7evyn (458) costs
 * 0.47 ms/step plus 1.79 ms/frame of snapshot encoding — the encode
 * (every serializer component of every entity, per frame) is the term
 * that scales worst, and >2 ms of a 16 ms frame on rocks alone is too
 * much next to everything else the frame must do. 256 holds the worst
 * systems to ~0.24 ms/step + ~0.66 ms/frame while leaving all systems
 * with count <= 5 (the vast majority; Fomalhaut included) uncapped.
 */
export const MAX_ASTEROIDS_PER_SYSTEM = 256;
/** How often a depleted field regenerates one asteroid. */
const RESPAWN_INTERVAL_MS = 5000;
/** Asteroid drift speed range, px/s. */
const ASTEROID_MIN_SPEED = 10;
const ASTEROID_MAX_SPEED = 50;
/** Fragment ejection speed range, px/s (added to the parent velocity). */
const FRAGMENT_MIN_SPEED = 15;
const FRAGMENT_MAX_SPEED = 60;
/** Resource-box ejection speed range, px/s. */
const DEBRIS_MIN_SPEED = 20;
const DEBRIS_MAX_SPEED = 80;
/** How long a resource-box lasts before fading away, ms. */
export const DEBRIS_LIFETIME_MS = 15_000;
/** Tumble rate of resource-boxes, rad/s. */
const DEBRIS_SPIN = 2.5;
/**
 * Hurtbox radius of a resource-box. Matches the rendered chunk: the
 * röid's 50x50 sprite at the display's DEBRIS_SCALE (0.35) is ~17 px.
 */
const DEBRIS_RADIUS = 9;
/** Hitbox radius fallback when an asteroid's sprite hull is unknown. */
const DEFAULT_ASTEROID_RADIUS = 20;

/**
 * A live asteroid. `id` is the röid's global id, `health` its remaining
 * strength, and `spin` its tumble rate in rad/s (rendering maps
 * rotation onto the sprite's frames, so spinning the rotation plays the
 * tumble animation). Queryable by NPC AI (e.g. future mining behavior)
 * to find asteroids to shoot.
 */
export const AsteroidType = t.type({
    id: t.string, // Not a UUID. A nova id.
    health: t.number,
    spin: t.number,
});
export type AsteroidType = t.TypeOf<typeof AsteroidType>;
export const AsteroidComponent = new Component<AsteroidType>('Asteroid');

/** Static röid data; shared, never mutated. */
export const AsteroidDataComponent = new Component<AsteroidData>('AsteroidData');

/**
 * A scoopable resource-box ejected by a destroyed asteroid. `commodity`
 * is the cargo key it grants (see CargoComponent), `expires` the sim
 * time (ms) at which it fades away. Queryable by NPC AI to find debris
 * to scoop.
 */
export const DebrisType = t.type({
    commodity: t.string,
    expires: t.number,
    spin: t.number,
});
export type DebrisType = t.TypeOf<typeof DebrisType>;
export const DebrisComponent = new Component<DebrisType>('Debris');

/**
 * Per-system asteroid field state, attached to a dedicated entity with
 * the deterministic uuid 'asteroid field'. Tracks the spawn target so
 * destroyed asteroids eventually drift back in (the original respawns
 * offscreen to keep the count constant).
 */
export const AsteroidFieldType = t.type({
    /** How many asteroids the field wants alive. */
    targetCount: t.number,
    /** Global röid ids that spawn here. */
    types: t.array(t.string),
    /** Sim time (ms) after which the field may regenerate an asteroid. */
    nextRespawn: t.number,
});
export type AsteroidFieldType = t.TypeOf<typeof AsteroidFieldType>;
export const AsteroidFieldComponent = new Component<AsteroidFieldType>('AsteroidField');

/** Emitted when an asteroid breaks apart, for display effects. */
export const AsteroidBreakEvent = new EcsEvent<{
    position: Position,
    explosion?: string,
    particleCount: number,
    particleColor: number,
}>('AsteroidBreakEvent');
export const AsteroidBreakEventType = t.intersection([
    t.type({
        position: PositionType,
        particleCount: t.number,
        particleColor: t.number,
    }),
    t.partial({
        explosion: t.string,
    }),
]);
registerSimulationBridgeEvent({
    event: AsteroidBreakEvent,
    includeEntityUuids: false,
});

function mod(n: number, m: number): number {
    return ((n % m) + m) % m;
}

/**
 * Advances a drifting, tumbling body. Replaces (never mutates) the
 * position and rotation objects: snapshot codecs encode t.type
 * structures by identity, so rollback snapshots share the live objects
 * and in-place mutation would corrupt history. This is the same
 * replace-don't-mutate contract MovementSystem follows; the only
 * per-asteroid allocations per tick are these two small objects, which
 * die young.
 */
function drift(state: MovementState, spin: number, delta_s: number,
    wrapHalfSize: number) {
    const x = mod(state.position.x + state.velocity.x * delta_s
        + wrapHalfSize, 2 * wrapHalfSize) - wrapHalfSize;
    const y = mod(state.position.y + state.velocity.y * delta_s
        + wrapHalfSize, 2 * wrapHalfSize) - wrapHalfSize;
    state.position = new Position(x, y);
    state.rotation = new Angle(state.rotation.angle + spin * delta_s);
}

const AsteroidMotionSystem = new System({
    name: 'AsteroidMotionSystem',
    args: [AsteroidComponent, MovementStateComponent, TimeResource] as const,
    step(asteroid, movement, time) {
        drift(movement, asteroid.spin, time.delta_s,
            ASTEROID_FIELD_HALF_SIZE);
    },
    // after TimeSystem matters for determinism, not just freshness: a
    // system that reads TimeResource before TimeSystem updates it sees
    // delta_s = 0 on a world's very first step but the previous delta
    // on the first step after a wire-baseline restore, so a late
    // joiner's asteroids would drift one extra step out of lockstep.
    after: [TimeSystem],
    before: [UpdateHitboxHullSystem, UpdateHurtboxHullSystem],
});

const DebrisMotionSystem = new System({
    name: 'DebrisMotionSystem',
    args: [DebrisComponent, MovementStateComponent, TimeResource,
        Entities, UUID] as const,
    step(debris, movement, time, entities, uuid) {
        if (time.time > debris.expires) {
            entities.delete(uuid);
            return;
        }
        // Debris drifts and expires long before it could reach the
        // world wrap boundary, so wrap at the world's edge.
        drift(movement, debris.spin, time.delta_s, 10000);
    },
    // See AsteroidMotionSystem: after TimeSystem is load-bearing for
    // late-join determinism.
    after: [TimeSystem],
    before: [UpdateHitboxHullSystem, UpdateHurtboxHullSystem],
});

/**
 * The tumble rate that plays the sprite's frames at the röid's
 * SpinRate. Rendering divides a full rotation among the sprite's
 * frames, so frameRate frames/s equals frameRate/frames revolutions/s.
 */
function spinFor(data: AsteroidData, random: Random): number {
    const frames = data.animation.images.baseImage.frames.normal.length || 1;
    const spin = 2 * Math.PI * data.frameRate / frames;
    return random.next() < 0.5 ? -spin : spin;
}

/** The asteroid's collision radius, from its sprite's convex hulls. */
function asteroidRadius(gameData: SimulationGameDataInterface,
    data: AsteroidData): number {
    const spriteSheet = gameData.data.SpriteSheet
        .getCached(data.animation.images.baseImage.id);
    const firstFrame = spriteSheet?.hulls?.[0];
    if (!firstFrame?.length) {
        return DEFAULT_ASTEROID_RADIUS;
    }
    let radiusSquared = 0;
    for (const convexHull of firstFrame) {
        for (const [x, y] of convexHull) {
            radiusSquared = Math.max(radiusSquared, x * x + y * y);
        }
    }
    return Math.sqrt(radiusSquared) || DEFAULT_ASTEROID_RADIUS;
}

/**
 * A uniform random unit vector, built from IEEE-exact operations only.
 * Math.cos/Math.sin are NOT bit-identical across JS engines (node's V8
 * and Chrome's differ in the last ulp for some inputs), and asteroid
 * spawn state is genesis state — it is never corrected by input
 * records, so any engine-dependent bit puts a browser client
 * permanently out of lockstep with the server's archive. Rejection
 * sampling + sqrt/divide are correctly rounded per IEEE 754 and thus
 * identical everywhere.
 */
function randomDirection(random: Random): Vector {
    while (true) {
        const x = random.next() * 2 - 1;
        const y = random.next() * 2 - 1;
        const lengthSquared = x * x + y * y;
        if (lengthSquared > 1e-6 && lengthSquared <= 1) {
            const length = Math.sqrt(lengthSquared);
            return new Vector(x / length, y / length);
        }
    }
}

function randomBetween(random: Random, min: number, max: number): number {
    return min + random.next() * (max - min);
}

/** ±50% of an average, rounded, as the Bible specifies for yields. */
function averagePlusMinusHalf(average: number, random: Random): number {
    return Math.round(average * (0.5 + random.next()));
}

export function makeAsteroid(gameData: SimulationGameDataInterface,
    data: AsteroidData, random: Random, position: Position,
    velocity: Vector): Entity {
    return new Entity(data.name)
        .addComponent(AsteroidComponent, {
            id: data.id,
            health: data.strength,
            spin: spinFor(data, random),
        })
        .addComponent(AsteroidDataComponent, data)
        .addComponent(AnimationComponent, data.animation)
        .addComponent(MovementStateComponent, {
            position,
            velocity,
            rotation: new Angle(random.next() * 2 * Math.PI),
            accelerating: 0,
            turning: 0,
            turnBack: false,
        })
        .addComponent(HitboxHullComponent, new CompositeHull([
            new SAT.Circle(new SAT.Vector(0, 0),
                asteroidRadius(gameData, data)),
        ]))
        .addComponent(CollisionVulnerabilityComponent, {
            vulnerableTo: new Set(['normal']),
        })
        // Jammed missiles with the "decoyed by asteroids" seeker flag
        // retarget onto the nearest decoy (see findNearestDecoy in
        // jamming_plugin.ts).
        .addComponent(DecoyTargetComponent, { weight: 1 });
}

function makeDebris(data: AsteroidData, random: Random, position: Position,
    velocity: Vector, expires: number): Entity {
    return new Entity(`${data.name} debris`)
        .addComponent(DebrisComponent, {
            commodity: data.yieldType!,
            expires,
            spin: random.next() < 0.5 ? -DEBRIS_SPIN : DEBRIS_SPIN,
        })
        // The shared debrisAnimation reference lets the display pool
        // graphics across all boxes of the same röid type.
        .addComponent(AnimationComponent, data.debrisAnimation!)
        .addComponent(MovementStateComponent, {
            position,
            velocity,
            rotation: new Angle(random.next() * 2 * Math.PI),
            accelerating: 0,
            turning: 0,
            turnBack: false,
        })
        .addComponent(HurtboxHullComponent, new CompositeHull([
            new SAT.Circle(new SAT.Vector(0, 0), DEBRIS_RADIUS),
        ]))
        // Only ships are vulnerable to 'debris', so boxes never collide
        // with asteroids, projectiles, or each other.
        .addComponent(CollisionHitterComponent, {
            hitTypes: new Set(['debris']),
        });
}

function spawnFieldAsteroid(entities: EntityMap,
    gameData: SimulationGameDataInterface, ids: IdFactory, random: Random,
    types: string[], atEdge: boolean) {
    if (types.length === 0) {
        return;
    }
    const data = gameData.data.Asteroid
        .getCached(types[random.below(types.length)]);
    if (!data) {
        return;
    }
    let x = randomBetween(random, -ASTEROID_FIELD_HALF_SIZE,
        ASTEROID_FIELD_HALF_SIZE);
    let y = randomBetween(random, -ASTEROID_FIELD_HALF_SIZE,
        ASTEROID_FIELD_HALF_SIZE);
    if (atEdge) {
        // Respawned asteroids drift in from a field edge instead of
        // popping into the middle of a battle.
        if (random.next() < 0.5) {
            x = -ASTEROID_FIELD_HALF_SIZE;
        } else {
            y = -ASTEROID_FIELD_HALF_SIZE;
        }
    }
    const velocity = randomDirection(random).scale(randomBetween(
        random, ASTEROID_MIN_SPEED, ASTEROID_MAX_SPEED));
    entities.set(ids.next('asteroid'),
        makeAsteroid(gameData, data, random, new Position(x, y), velocity));
}

/**
 * Loads the transitive closure of data an asteroid type needs: its own
 * data and sprite sheet (for the collision radius) plus everything its
 * fragments need, recursively, so mid-simulation breakup is synchronous.
 */
export async function loadAsteroidGameData(
    gameData: SimulationGameDataInterface, asteroidId: string,
    seen = new Set<string>()): Promise<void> {
    if (seen.has(asteroidId)) {
        return;
    }
    seen.add(asteroidId);
    let data: AsteroidData;
    try {
        data = await gameData.data.Asteroid.get(asteroidId);
    } catch (e) {
        console.warn(`Failed to load asteroid ${asteroidId}:`, e);
        return;
    }
    try {
        await gameData.data.SpriteSheet.get(data.animation.images.baseImage.id);
    } catch (e) {
        console.warn(`Failed to load sprite sheet for asteroid ${asteroidId}:`, e);
    }
    for (const fragment of data.fragments) {
        await loadAsteroidGameData(gameData, fragment, seen);
    }
}

/**
 * Spawns a system's asteroid field: SystemData.asteroids per reference
 * screen area across the field, of the system's röid types, from the
 * world's deterministic Random (same system seed -> same field). Call
 * from makeSystem before the world steps.
 */
export async function spawnAsteroids(world: World,
    systemData: { asteroids: number, asteroidTypes: string[] }) {
    if (systemData.asteroids <= 0 || systemData.asteroidTypes.length === 0) {
        return;
    }
    const gameData = world.resources.get(SimulationGameDataResource);
    const random = world.resources.get(RandomResource);
    const ids = world.resources.get(IdFactoryResource);
    if (!gameData || !random || !ids) {
        throw new Error('Expected game data, random, and id factory resources');
    }

    for (const typeId of systemData.asteroidTypes) {
        await loadAsteroidGameData(gameData, typeId);
    }

    const fieldScreens = (2 * ASTEROID_FIELD_HALF_SIZE) ** 2
        / REFERENCE_SCREEN_AREA;
    const targetCount = Math.min(MAX_ASTEROIDS_PER_SYSTEM,
        Math.round(systemData.asteroids * fieldScreens));

    for (let i = 0; i < targetCount; i++) {
        spawnFieldAsteroid(world.entities, gameData, ids, random,
            systemData.asteroidTypes, false);
    }

    const field = new Entity('asteroid field')
        .addComponent(AsteroidFieldComponent, {
            targetCount,
            types: systemData.asteroidTypes,
            nextRespawn: 0,
        });
    world.entities.set('asteroid field', field);
}

const LiveAsteroidsQuery = new Query([AsteroidComponent] as const);

/**
 * Regenerates destroyed asteroids one at a time, from a field edge,
 * until the field is back at its target count. Fragments count toward
 * the target, so a freshly shattered field pauses before regrowing.
 */
const AsteroidRespawnSystem = new System({
    name: 'AsteroidRespawnSystem',
    args: [AsteroidFieldComponent, LiveAsteroidsQuery, TimeResource,
        Entities, RandomResource, IdFactoryResource,
        SimulationGameDataResource] as const,
    step(field, liveAsteroids, time, entities, random, ids, gameData) {
        if (time.time < field.nextRespawn
            || liveAsteroids.length >= field.targetCount) {
            return;
        }
        field.nextRespawn = time.time + RESPAWN_INTERVAL_MS;
        spawnFieldAsteroid(entities, gameData, ids, random, field.types, true);
    },
});

const DamagerQuery = new Query([Optional(ProjectileDataComponent),
    Optional(BeamDataComponent), Optional(MovementStateComponent)] as const);

/**
 * Applies weapon damage to asteroids and breaks them apart. Asteroids
 * take a weapon's mass (armor) damage against their strength, times 10
 * for "asteroid miner" weapons (wëap flags2 0x8000). A destroyed
 * asteroid ejects sub-asteroids and scoopable resource-boxes, both
 * averaged ±50% per the Bible.
 */
const AsteroidDamageSystem = new System({
    name: 'AsteroidDamageSystem',
    events: [DamagedEvent],
    args: [DamagedEvent, AsteroidComponent, AsteroidDataComponent,
        MovementStateComponent, RunQuery, UUID, Entities, Emit,
        RandomResource, IdFactoryResource, SimulationGameDataResource,
        TimeResource] as const,
    step({ damage, damager, scale = 1 }, asteroid, data, movement, runQuery,
        uuid, entities, emit, random, ids, gameData, time) {
        if (asteroid.health <= 0) {
            return; // Already broken apart this tick.
        }

        const [damagerParts] = runQuery(DamagerQuery, damager);
        const weaponData = damagerParts?.[0] ?? damagerParts?.[1];
        let armorDamage = damage.armor * scale;
        if (weaponData?.asteroidMiner) {
            armorDamage *= 10;
        }

        // Knockback, scaled by the röid's mass.
        const damagerMovement = damagerParts?.[2];
        if (damage.knockback && damagerMovement && data.mass > 0) {
            movement.velocity = movement.velocity.add(
                damagerMovement.rotation.getUnitVector()
                    .scale(damage.knockback * scale * 5 / data.mass));
        }

        if (armorDamage <= 0) {
            return;
        }
        asteroid.health -= armorDamage;
        if (asteroid.health > 0) {
            return;
        }

        // Break apart: sub-asteroids...
        const position = Position.fromVectorLike(movement.position);
        if (data.fragments.length > 0) {
            const fragmentCount =
                averagePlusMinusHalf(data.fragmentCount, random);
            for (let i = 0; i < fragmentCount; i++) {
                const fragmentData = gameData.data.Asteroid.getCached(
                    data.fragments[random.below(data.fragments.length)]);
                if (!fragmentData) {
                    continue;
                }
                const velocity = Vector.fromVectorLike(movement.velocity)
                    .add(randomDirection(random).scale(randomBetween(
                        random, FRAGMENT_MIN_SPEED, FRAGMENT_MAX_SPEED)));
                entities.set(ids.next('asteroid'), makeAsteroid(
                    gameData, fragmentData, random, position, velocity));
            }
        }

        // ...and resource-boxes.
        if (data.yieldType && data.debrisAnimation) {
            const boxCount = averagePlusMinusHalf(data.yieldQuantity, random);
            for (let i = 0; i < boxCount; i++) {
                const velocity = randomDirection(random).scale(randomBetween(
                    random, DEBRIS_MIN_SPEED, DEBRIS_MAX_SPEED));
                entities.set(ids.next('debris'), makeDebris(
                    data, random, position, velocity,
                    time.time + DEBRIS_LIFETIME_MS));
            }
        }

        entities.delete(uuid);
        emit(AsteroidBreakEvent, {
            position,
            explosion: data.explosion ?? undefined,
            particleCount: data.particles.count,
            particleColor: data.particles.color,
        });
    },
});

/**
 * Scoops debris a ship runs over into its cargo hold, if the ship
 * carries a mining scoop outfit (ModType 31) and has cargo space free.
 */
const ScoopSystem = new System({
    name: 'ScoopSystem',
    events: [CollisionEvent],
    args: [CollisionEvent, Entities, CargoComponent, OutfitsStateComponent,
        ShipPhysicsComponent, SimulationGameDataResource] as const,
    step(collision, entities, cargo, outfits, physics, gameData) {
        const other = entities.get(collision.other);
        const debris = other?.components.get(DebrisComponent);
        if (!debris) {
            return;
        }

        let hasScoop = false;
        for (const [outfitId, { count }] of outfits) {
            if (count > 0
                && gameData.data.Outfit.getCached(outfitId)?.miningScoop) {
                hasScoop = true;
                break;
            }
        }
        if (!hasScoop) {
            return;
        }
        if (cargoUsed(cargo) + 1 > physics.freeCargo) {
            return;
        }
        cargo.set(debris.commodity, (cargo.get(debris.commodity) ?? 0) + 1);
        entities.delete(collision.other);
    },
});

function deriveAsteroidData(gameData: SimulationGameDataInterface,
    asteroid: { id: string }) {
    return gameData.data.Asteroid.getCached(asteroid.id);
}

export const AsteroidPlugin: Plugin = {
    name: 'AsteroidPlugin',
    build(world) {
        const serializer = world.resources.get(SerializerResource);
        serializer?.addComponent(AsteroidComponent, AsteroidType);
        serializer?.addComponent(DebrisComponent, DebrisType);
        serializer?.addComponent(AsteroidFieldComponent, AsteroidFieldType);
        serializer?.addEvent(AsteroidBreakEvent, AsteroidBreakEventType);

        // AsteroidDataComponent is intentionally NOT serializer
        // registered: it is static shared data, and registering it
        // would re-encode it per asteroid per display frame. Wire
        // snapshot restores derive it from AsteroidComponent instead
        // (see snapshot_policies.ts).
        registerEntityDeriver(world, {
            name: 'AsteroidDataDeriver',
            provided: AsteroidDataComponent,
            requires: [AsteroidComponent],
            derive: (entity, gameData) => deriveAsteroidData(
                gameData, entity.components.get(AsteroidComponent)!),
        });

        world.addSystem(AsteroidMotionSystem);
        world.addSystem(DebrisMotionSystem);
        world.addSystem(AsteroidRespawnSystem);
        world.addSystem(AsteroidDamageSystem);
        world.addSystem(ScoopSystem);
    },
};
