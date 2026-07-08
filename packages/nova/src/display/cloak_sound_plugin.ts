import { Emit, GetEntity } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { System } from "nova_ecs/system";
import { CloakActiveComponent } from "../nova_plugin/cloak_plugin.js";
import { DisplayAssetDataResource } from "../nova_plugin/game_data_resource.js";
import { SoundEvent } from "../nova_plugin/sound_plugin.js";

// The stock Nova cloak sounds (snd resources in the Nova Files id space).
export const CLOAK_ON_SOUND = 'nova:381';  // snd 381 "Cloak On"
export const CLOAK_OFF_SOUND = 'nova:380'; // snd 380 "Cloak Off"

/**
 * Display-world-local memory of a ship's last observed cloak state, used
 * to edge-detect activations/deactivations. Lives only in the display
 * world (never synced), so it cannot affect the deterministic sim.
 */
const CloakSoundState =
    new Component<{ wasActive: boolean }>('CloakSoundState');

/**
 * Pure edge detector: given the last observed and current cloak-active
 * flags, returns the sound id to play for this transition, or undefined
 * for no transition. Plays exactly once per edge, never loops.
 */
export function cloakTransitionSound(
    wasActive: boolean, active: boolean): string | undefined {
    if (active === wasActive) {
        return undefined;
    }
    return active ? CLOAK_ON_SOUND : CLOAK_OFF_SOUND;
}

/**
 * Plays the cloak sounds off the sim's CloakActiveComponent transitions:
 * snd 381 "Cloak On" once when a cloak activates and snd 380 "Cloak Off"
 * once when it deactivates — regardless of the decloak path (manual
 * toggle, decloak-on-hit, shield/fuel exhaustion), since all paths flow
 * through the same synced component. Presentation only: it reacts to
 * synced state and emits a display-world SoundEvent, so determinism is
 * untouched.
 */
export const CloakSoundSystem = new System({
    name: 'CloakSoundSystem',
    args: [CloakActiveComponent, Optional(CloakSoundState),
        GetEntity, Emit] as const,
    step(cloakActive, state, entity, emit) {
        if (!state) {
            // The sim creates CloakActiveComponent on the first toggle,
            // so a ship first seen with an active cloak just cloaked:
            // start from "was not cloaked" so that edge plays too.
            state = { wasActive: false };
            entity.components.set(CloakSoundState, state);
        }
        const sound = cloakTransitionSound(state.wasActive, cloakActive.active);
        state.wasActive = cloakActive.active;
        if (sound !== undefined) {
            emit(SoundEvent, { id: sound });
        }
    },
});

export const CloakSoundPlugin: Plugin = {
    name: 'CloakSoundPlugin',
    build(world) {
        world.addComponent(CloakSoundState);
        // Pre-warm the two cloak sounds: the display SoundSystem plays
        // from the cache (getCached), so without this the very first
        // cloak edge could be silent while the sound loads.
        const displayAssets = world.resources.get(DisplayAssetDataResource);
        displayAssets?.data.Sound.get(CLOAK_ON_SOUND);
        displayAssets?.data.Sound.get(CLOAK_OFF_SOUND);
        world.addSystem(CloakSoundSystem);
    },
    remove(world) {
        world.removeSystem(CloakSoundSystem);
    },
};
