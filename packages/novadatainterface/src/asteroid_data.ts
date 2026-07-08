import { Animation, getDefaultAnimation } from "./animation.js";
import { BaseData, getDefaultBaseData } from "./base_data.js";


/**
 * An asteroid type (a röid resource). Nova supports up to 16 asteroid
 * types; each system chooses which appear via a bitmask (see
 * SystemData.asteroidTypes) and how many to keep on screen at once
 * (SystemData.asteroids). EVN Bible p. 52.
 */
export interface AsteroidData extends BaseData {
    /** The tumbling asteroid sprite (spïn 800-815). */
    animation: Animation;
    /** Strength; equivalent to a ship's armor value. */
    strength: number;
    /**
     * Frames per second of the tumbling animation. The raw SpinRate is
     * "frame advance rate" where 100 = 30 fps; this is pre-converted.
     */
    frameRate: number;
    /**
     * What one ejected resource-box contains, or null for none:
     * "cargo:<0-5>" for a standard cargo type, or "junk:<globalID>" for
     * a jünk commodity. This string is the commodity key used by the
     * (nascent) cargo system.
     */
    yieldType: string | null;
    /** Average number of resource-boxes ejected on destruction (±50%). */
    yieldQuantity: number;
    /**
     * The sprite for ejected resource-boxes: the cargo box (spïn 500)
     * for standard cargo, or a mini-asteroid (spïn 501-504) for jünk.
     * Null when the asteroid yields nothing.
     */
    debrisAnimation: Animation | null;
    /**
     * Global ids of the sub-asteroid types this one breaks into. Empty
     * for none; if there are two, each fragment picks randomly.
     */
    fragments: string[];
    /** Average number of sub-asteroids generated on destruction (±50%). */
    fragmentCount: number;
    /** Explosion (global id) shown on destruction, or null for none. */
    explosion: string | null;
    /** Particles thrown off on destruction. */
    particles: {
        count: number,
        /** 00RRGGBB */
        color: number,
    };
    /** Mass, used when weapons hit the asteroid (knockback). */
    mass: number;
}

export function getDefaultAsteroidData(): AsteroidData {
    return {
        ...getDefaultBaseData(),
        animation: getDefaultAnimation(),
        strength: 100,
        frameRate: 30,
        yieldType: null,
        yieldQuantity: 0,
        debrisAnimation: null,
        fragments: [],
        fragmentCount: 0,
        explosion: null,
        particles: { count: 0, color: 0xffffff },
        mass: 100,
    };
}
