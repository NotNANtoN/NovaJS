import { BOUNDARY } from 'nova_ecs/datatypes/position';
import { VectorLike } from 'nova_ecs/datatypes/vector';

/**
 * Retail Nova places its sounds in the world: a hull coming apart on the far
 * side of the system is faint, while your own is not. Without this a distant
 * ship breaking up is indistinguishable from your own death.
 *
 * Anything this close counts as "right here", which covers the player's own
 * ship and the space actually on screen.
 */
export const SOUND_FULL_VOLUME_RADIUS = 700;

/**
 * Past this a world sound is silent. It is inside the multiplayer interest
 * radius of 6000, so ships are already inaudible before they stop being
 * replicated.
 */
export const SOUND_SILENCE_RADIUS = 5_000;

function wrappedAxisDistance(a: number, b: number): number {
    const direct = Math.abs(a - b);
    return Math.min(direct, BOUNDARY * 2 - direct);
}

/** Distance across the wrapping system plane. */
export function soundDistance(a: VectorLike, b: VectorLike): number {
    return Math.hypot(
        wrappedAxisDistance(a.x, b.x),
        wrappedAxisDistance(a.y, b.y),
    );
}

/**
 * The share of the master volume a sound at this distance should play at.
 * Falls off linearly, which keeps nearby combat loud while making the far
 * side of the system a background rumble.
 */
export function distanceAttenuation(distance: number): number {
    if (!Number.isFinite(distance) || distance <= SOUND_FULL_VOLUME_RADIUS) {
        return 1;
    }
    if (distance >= SOUND_SILENCE_RADIUS) {
        return 0;
    }
    return (SOUND_SILENCE_RADIUS - distance)
        / (SOUND_SILENCE_RADIUS - SOUND_FULL_VOLUME_RADIUS);
}

/**
 * Volume for a sound emitted at `source`, heard by a listener at `listener`.
 * A sound with no place in the world, such as a UI beep or the player's own
 * cockpit alerts, is not attenuated.
 */
export function worldSoundVolume(
    masterVolume: number,
    source: VectorLike | undefined,
    listener: VectorLike | undefined,
): number {
    if (!source || !listener) {
        return masterVolume;
    }
    return masterVolume * distanceAttenuation(soundDistance(source, listener));
}
