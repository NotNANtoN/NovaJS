import { BlinkPattern } from "novadatainterface/animation";

/**
 * Running-light blinking, translated from the shän resource's BlinkMode /
 * BlinkValA-D fields (EVN Bible pp. 15). Pure, display-only functions:
 * given a ship's blink pattern and a wall-clock time, they return how the
 * running-lights sprite layer should look this frame.
 *
 * All shän blink timings are in animation frames = 30ths of a second, so we
 * convert times to frames here.
 */

/** Animation frames per second, per the shän timing fields. */
const FRAMES_PER_SECOND = 30;
const MS_PER_FRAME = 1000 / FRAMES_PER_SECOND;

/** shän intensities run 1-32; this is the fully-lit value. */
const MAX_SHAN_INTENSITY = 32;

/**
 * How the running-lights layer should be drawn this frame.
 * `alpha` is in [0, 1]; `visible` is a convenience for callers that only
 * toggle visibility (equivalent to `alpha > 0`).
 */
export interface LightState {
    visible: boolean;
    alpha: number;
}

const OFF: LightState = { visible: false, alpha: 0 };
const ON: LightState = { visible: true, alpha: 1 };

/**
 * Computes the running-light state for a ship at a given time.
 *
 * @param blink   The ship's blink pattern, or null for a steady light.
 * @param timeMs  A monotonic wall-clock/frame time in milliseconds.
 * @param phaseMs A per-ship phase offset in milliseconds so that a fleet of
 *                identical ships doesn't blink in unison. Derive it from
 *                something stable per entity (e.g. a uuid hash). Defaults to 0.
 */
export function runningLightState(
    blink: BlinkPattern | null,
    timeMs: number,
    phaseMs: number = 0,
): LightState {
    // No blink pattern: a steady, always-on running light.
    if (!blink) {
        return ON;
    }

    const t = timeMs + phaseMs;

    switch (blink.mode) {
        case "square":
            return squareState(blink, t);
        case "triangle":
            return triangleState(blink, t);
        case "random":
            return randomState(blink, t);
    }
}

/**
 * Square-wave strobe: `blinksPerGroup` flashes (each `onFrames` on then
 * `offFrames` off), then a long `groupDelayFrames` off before the group
 * repeats. Produces e.g. the stock double-blink of most Nova ships.
 */
function squareState(
    blink: Extract<BlinkPattern, { mode: "square" }>,
    timeMs: number,
): LightState {
    const on = Math.max(0, blink.onFrames);
    const off = Math.max(0, blink.offFrames);
    const count = Math.max(1, blink.blinksPerGroup);
    const groupDelay = Math.max(0, blink.groupDelayFrames);

    // One blink = on-time followed by the between-blink off-time. A group is
    // `count` blinks, then the (longer) between-group delay.
    const blinkFrames = on + off;
    const groupFrames = blinkFrames * count + groupDelay;
    if (groupFrames <= 0) {
        // Degenerate pattern (all zero): treat as steady on.
        return ON;
    }

    const frame = mod(timeMs / MS_PER_FRAME, groupFrames);

    // Inside the burst of blinks?
    const burstFrames = blinkFrames * count;
    if (frame < burstFrames) {
        // Which blink, and where within it.
        const withinBlink = mod(frame, blinkFrames);
        return withinBlink < on ? ON : OFF;
    }
    // In the between-group delay: off.
    return OFF;
}

/**
 * Triangle-wave pulse: intensity ramps linearly up from `minIntensity` to
 * `maxIntensity` (rising `riseRate`/frame) then back down (falling
 * `fallRate`/frame), repeating. Intensity 1-32 maps to alpha.
 */
function triangleState(
    blink: Extract<BlinkPattern, { mode: "triangle" }>,
    timeMs: number,
): LightState {
    const min = clampIntensity(blink.minIntensity);
    const max = clampIntensity(blink.maxIntensity);
    // Rates are stored x100 per the Bible ("intensity increase per frame,
    // x100"), so a stored 75 means 0.75 intensity units per frame.
    const rise = blink.riseRate / 100;
    const fall = blink.fallRate / 100;
    const span = Math.max(0, max - min);

    if (span === 0 || rise <= 0 || fall <= 0) {
        // No usable ramp: hold at the (clamped) intensity.
        return intensityState(max);
    }

    const riseFrames = span / rise;
    const fallFrames = span / fall;
    const period = riseFrames + fallFrames;

    const frame = mod(timeMs / MS_PER_FRAME, period);
    const intensity = frame < riseFrames
        ? min + frame * rise
        : max - (frame - riseFrames) * fall;

    return intensityState(intensity);
}

/**
 * Random pulse: intensity jumps to a fresh pseudo-random value in
 * [minIntensity, maxIntensity] every `changeDelayFrames` frames. The value is
 * a deterministic function of which step we're in, so it's stable per frame
 * and reproducible for testing (no global RNG state).
 */
function randomState(
    blink: Extract<BlinkPattern, { mode: "random" }>,
    timeMs: number,
): LightState {
    const min = clampIntensity(blink.minIntensity);
    const max = clampIntensity(blink.maxIntensity);
    const delay = Math.max(1, blink.changeDelayFrames);

    const step = Math.floor(timeMs / MS_PER_FRAME / delay);
    const r = hashStepToUnit(step);
    const intensity = min + r * Math.max(0, max - min);
    return intensityState(intensity);
}

/** Maps a shän intensity (1-32) to a LightState with alpha in [0, 1]. */
function intensityState(intensity: number): LightState {
    const alpha = clamp(intensity / MAX_SHAN_INTENSITY, 0, 1);
    return { visible: alpha > 0, alpha };
}

function clampIntensity(intensity: number): number {
    return clamp(intensity, 0, MAX_SHAN_INTENSITY);
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x));
}

/** Non-negative modulo. */
function mod(a: number, n: number): number {
    return ((a % n) + n) % n;
}

/**
 * Deterministic hash of an integer step to a value in [0, 1). Cheap integer
 * mixer (no Math.random) so random-mode blinking is reproducible per step.
 */
function hashStepToUnit(step: number): number {
    let x = (step | 0) >>> 0;
    x = (x ^ 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    return x / 0x100000000;
}

/**
 * A stable per-entity phase offset in milliseconds, derived from the entity's
 * uuid so identical ships in a fleet don't all blink at the same instant.
 * Spread across a couple of seconds, which comfortably covers stock periods.
 */
export function blinkPhaseFromUuid(uuid: string): number {
    let h = 2166136261 >>> 0; // FNV-1a
    for (let i = 0; i < uuid.length; i++) {
        h = (h ^ uuid.charCodeAt(i)) >>> 0;
        h = Math.imul(h, 16777619) >>> 0;
    }
    // Spread over 2000 ms.
    return (h % 2000);
}
