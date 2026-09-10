import { EcsEvent } from 'nova_ecs/events';
import { EmitFunction } from 'nova_ecs/arg_types';


// Retail snd 150 is the scenario's generic "Beep1" UI feedback sound. No
// target-cycle-specific resource is documented, so the existing UI beep is the
// evidenced fallback instead of an invented sound ID.
export const TARGET_SELECTION_SOUND_ID = 'nova:150';

// Retail snd 371 is named "Klaxxon"; it is the closest warning resource in the
// data because no missile-lock-specific sound field is documented.
export const INCOMING_MISSILE_SOUND_ID = 'nova:371';

// Retail snd 390 is named "Airlock", which is the evidenced one-shot sound for
// entering or leaving a docked stellar.
export const STELLAR_DOCKING_SOUND_ID = 'nova:390';
export const STELLAR_DEPARTURE_SOUND_ID = STELLAR_DOCKING_SOUND_ID;

/**
 * `position` places the sound in the system, so it can be attenuated by how
 * far away it happened. Omit it for sounds that belong to the pilot rather
 * than to a place: UI feedback, cockpit warnings, and their own hyperspace
 * transitions.
 */
export interface SoundEventData {
    id: string;
    loop?: boolean;
    stop?: boolean;
    position?: { x: number, y: number };
}

class SoundEcsEvent extends EcsEvent<SoundEventData> {
    /**
     * Use this for positional sounds: queued events and their subscribers must
     * not retain movement drafts that delta tracking can revoke before playback.
     * EcsEvent has no transform hook, so snapshot before calling the emitter.
     */
    emit(emit: EmitFunction, data: SoundEventData): void {
        const snapshot = { ...data };
        if (data.position !== undefined) {
            snapshot.position = { x: data.position.x, y: data.position.y };
        }
        emit(this, snapshot);
    }
}

export const SoundEvent = new SoundEcsEvent('WeaponFire');
