import { wrapNearestDelta } from "nova_ecs/datatypes/position";
import { ParticleConfig } from "novadatainterface/weapon_data";
import { FRAMES_PER_SECOND, GpuParticleSystem, ParticleSpawn } from "./gpu_particles.js";

/**
 * Translation from the game's particle data (wëap trail/hit particles,
 * röid breakup dust) into birth records for the GPU particle system, plus
 * the framerate-independent emission accountancy for trails.
 *
 * Everything here is pure and PIXI-free apart from the `GpuParticleSystem`
 * the spawners write into, so the numbers that decide what a weapon's
 * particles look like are unit-testable without a renderer.
 */

/**
 * A burst: `count` particles thrown from a point (or from within
 * `radius` of it) in uniformly random directions. This is the shape of
 * every effect in the game — weapon trails emit a tiny burst per step,
 * hits emit one big burst, asteroid breakups emit one spread-out burst.
 */
export interface BurstConfig {
    /** Particles per burst. */
    count: number;
    /** Speed at birth, world px/s, before `speedJitterMin` scaling. */
    speed: number;
    /** End speed / start speed. 1 = constant velocity. */
    speedRatio: number;
    /** Lifetime is uniform in [lifeMin, lifeMax], seconds. */
    lifeMin: number;
    lifeMax: number;
    /** 0xRRGGBB. */
    color: number;
    /** Alpha at birth; particles always fade linearly to 0. */
    alpha: number;
    /** Half-extent at birth and at death, world px. */
    size0: number;
    size1: number;
    /** Additive (glowing sparks) rather than ordinary alpha (dust). */
    additive: boolean;
    /** Particles spawn within this radius of the burst's origin, px. */
    radius: number;
    /** Speed is scaled by a random factor in [speedJitterMin, 1]. */
    speedJitterMin: number;
    /** Size is scaled by a random factor in [sizeJitterMin, 1]. */
    sizeJitterMin: number;
}

/**
 * Half-extent of a spark, world px, so a spark covers ~2.5x2.5 px. The
 * emitter drew a 2x1 px white line texture at scale 1; a round soft disc
 * of about that footprint is the closest equivalent, nudged up a quarter
 * pixel because the disc's feathered rim gives away a little of the
 * emitter sprite's hard edge.
 */
export const SPARK_HALF_SIZE = 1.25;

/**
 * How much of a weapon's stored particle velocity becomes world speed.
 * Carried over verbatim from the emitter configuration this replaced
 * (`speed: particleConfig.velocity / 2`) so no weapon's trail changes
 * length or spread.
 */
export const PARTICLE_VELOCITY_SCALE = 0.5;

/**
 * Trail particles per second, per point of the wëap trail particle
 * Count. The field counts particles PER FRAME of a 30 fps engine (the
 * same 30 fps its lifetimes are measured in), so 30 Hz is the rate the
 * data actually asks for.
 *
 * The emitter this replaced used `frequency = 1 / app.ticker.FPS`
 * sampled once, at the projectile's first frame: the trail's density
 * depended on how fast the machine happened to be running right then
 * (twice as dense at 60 fps as at 30). Pinning the rate makes the trail
 * look the same on every machine and keeps its budget predictable.
 */
export const TRAIL_EMIT_HZ = 30;

/**
 * Ceiling on trail particles emitted for one entity in one step. A tab
 * that was hidden (or a GC pause) hands the display world a multi-second
 * delta; without this, one step would burn the whole ring on a single
 * projectile's backlog.
 */
export const MAX_TRAIL_PARTICLES_PER_STEP = 16;

/** How fast breakup dust drifts, px/s (the resource boxes drift 2.5-10). */
const DUST_SPEED_START = 12;
const DUST_SPEED_END = 3;
/** How long a dust mote lingers before fading out completely, seconds. */
const DUST_LIFE_MIN_S = 1.5;
const DUST_LIFE_MAX_S = 3;
/** Dust motes start about this big and shrink as they fade, world px. */
const DUST_HALF_SIZE_START = 1.5;
const DUST_HALF_SIZE_END = 0.75;

/**
 * A weapon's trail or hit particles as a burst. Both wëap particle
 * blocks have the same shape (count / velocity / life range / color) and
 * the emitter treated them identically: an isotropic burst of
 * constant-velocity additive sparks that fade out over their life, with
 * lifetimes stored in 30 fps frames.
 */
export function weaponBurst(config: ParticleConfig): BurstConfig {
    return {
        count: config.count,
        speed: config.velocity * PARTICLE_VELOCITY_SCALE,
        speedRatio: 1,
        lifeMin: config.lifeMin / FRAMES_PER_SECOND,
        lifeMax: config.lifeMax / FRAMES_PER_SECOND,
        color: config.color,
        alpha: 1,
        size0: SPARK_HALF_SIZE,
        size1: SPARK_HALF_SIZE,
        additive: true,
        radius: 0,
        speedJitterMin: 1,
        sizeJitterMin: 1,
    };
}

/**
 * An asteroid breakup's dust cloud: the röid's PartCount motes in its
 * PartColor, already spread across the asteroid's radius, drifting slowly
 * in the same speed regime as the resource boxes and fading out.
 *
 * Deliberately NOT `weaponBurst`: that burst (point spawn, additive
 * blend, sub-0.05s lifetimes) reads as a firework, and the original
 * engine's effect reads as dust.
 */
export function dustBurst(breakEvent: {
    particleCount: number, particleColor: number, radius: number,
}): BurstConfig {
    return {
        count: breakEvent.particleCount,
        speed: DUST_SPEED_START,
        speedRatio: DUST_SPEED_END / DUST_SPEED_START,
        lifeMin: DUST_LIFE_MIN_S,
        lifeMax: DUST_LIFE_MAX_S,
        color: breakEvent.particleColor,
        alpha: 0.9,
        size0: DUST_HALF_SIZE_START,
        size1: DUST_HALF_SIZE_END,
        // Dust obscures; additive blending would glow like sparks.
        additive: false,
        radius: breakEvent.radius,
        speedJitterMin: 0.3,
        sizeJitterMin: 0.5,
    };
}

/** Scratch record, refilled per particle — never one object per particle. */
const scratch: ParticleSpawn = {
    x: 0, y: 0, vx: 0, vy: 0, life: 0, size0: 0, size1: 0,
    speedRatio: 1, color: 0, alpha: 1, additive: true,
};

/**
 * Throws `count` particles from (x, y). Writes straight into the ring
 * buffer through a single reused scratch record, so a 100-particle hit
 * burst allocates nothing.
 *
 * `random` is injectable so tests can pin the jitter.
 */
export function spawnBurst(system: GpuParticleSystem, config: BurstConfig,
    x: number, y: number, count = config.count,
    random: () => number = Math.random) {
    for (let i = 0; i < count; i++) {
        const angle = random() * 2 * Math.PI;
        const speed = config.speed *
            (config.speedJitterMin + random() * (1 - config.speedJitterMin));
        const sizeScale =
            config.sizeJitterMin + random() * (1 - config.sizeJitterMin);
        scratch.vx = Math.cos(angle) * speed;
        scratch.vy = Math.sin(angle) * speed;
        if (config.radius > 0) {
            const spawnAngle = random() * 2 * Math.PI;
            const r = random() * config.radius;
            scratch.x = x + Math.cos(spawnAngle) * r;
            scratch.y = y + Math.sin(spawnAngle) * r;
        } else {
            scratch.x = x;
            scratch.y = y;
        }
        scratch.life = config.lifeMin +
            random() * (config.lifeMax - config.lifeMin);
        scratch.size0 = config.size0 * sizeScale;
        scratch.size1 = config.size1 * sizeScale;
        scratch.speedRatio = config.speedRatio;
        scratch.color = config.color;
        scratch.alpha = config.alpha;
        scratch.additive = config.additive;
        system.spawn(scratch);
    }
}

/**
 * How many trail particles an entity owes this step, and what is left
 * over. One small number per ENTITY (not per particle) keeps the trail's
 * density the same at any frame rate: the fractional remainder carries
 * into the next step instead of being rounded away.
 *
 * A backlog larger than `maxPerStep` (a hidden tab, a long GC pause) is
 * DROPPED rather than queued: the projectile was not visibly there for
 * those seconds, so drawing its whole missing trail at once would be
 * both wrong and a good way to blow the budget.
 */
export function advanceEmission(accumulator: number, rate: number,
    deltaSeconds: number,
    maxPerStep = MAX_TRAIL_PARTICLES_PER_STEP,
): { count: number, accumulator: number } {
    if (!(rate > 0) || !(deltaSeconds > 0)) {
        return { count: 0, accumulator: Number.isFinite(accumulator) ? accumulator : 0 };
    }
    let acc = accumulator + rate * deltaSeconds;
    if (!Number.isFinite(acc)) {
        return { count: 0, accumulator: 0 };
    }
    const owed = Math.floor(acc);
    acc -= owed;
    return { count: Math.min(owed, maxPerStep), accumulator: acc };
}

/**
 * Emits one step of a projectile's trail, spread evenly along the
 * segment it covered since the last step rather than dumped at its
 * current position. The emitter this replaced spawned every particle at
 * the projectile's current point, which beads the trail at low frame
 * rates; interpolating costs one lerp per particle and makes a fast
 * missile's trail continuous.
 *
 * The segment is measured backwards from the projectile's CURRENT
 * position along the shortest toroidal delta, so a projectile that
 * crossed the world's loop boundary this step lays its particles behind
 * itself instead of striping the whole world. The resulting positions
 * can fall outside the wrapped world range; the shader re-wraps every
 * particle against the camera anyway.
 */
export function spawnTrailSegment(system: GpuParticleSystem,
    config: BurstConfig, count: number,
    fromX: number, fromY: number, toX: number, toY: number,
    random: () => number = Math.random) {
    const dx = wrapNearestDelta(toX - fromX);
    const dy = wrapNearestDelta(toY - fromY);
    for (let i = 0; i < count; i++) {
        // (i + 1) / count so the last particle sits exactly on the
        // projectile and none is emitted at the previous step's point
        // (which already got one).
        const back = 1 - (i + 1) / count;
        spawnBurst(system, config, toX - dx * back, toY - dy * back, 1, random);
    }
}
