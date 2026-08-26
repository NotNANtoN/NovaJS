import { EcsEvent } from 'nova_ecs/events';


// Retail snd 150 is the scenario's generic "Beep1" UI feedback sound. No
// target-cycle-specific resource is documented, so the existing UI beep is the
// evidenced fallback instead of an invented sound ID.
export const TARGET_SELECTION_SOUND_ID = 'nova:150';

// Retail snd 371 is named "Klaxxon"; it is the closest warning resource in the
// data because no missile-lock-specific sound field is documented.
export const INCOMING_MISSILE_SOUND_ID = 'nova:371';

// Retail snd 301 is named "MedExplosion" and is referenced by bööm 129 as its
// impact sound. No generic shield or armour impact resource is provided.
export const HEALTH_HIT_SOUND_ID = 'nova:301';

// Retail snd 390 is named "Airlock", which is the evidenced one-shot sound for
// entering or leaving a docked stellar.
export const STELLAR_DOCKING_SOUND_ID = 'nova:390';
export const STELLAR_DEPARTURE_SOUND_ID = STELLAR_DOCKING_SOUND_ID;

export const SoundEvent = new EcsEvent<{ id: string, loop?: boolean }>('WeaponFire');
