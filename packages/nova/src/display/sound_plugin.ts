import { Sound } from '@pixi/sound';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { DisplayAssetDataResource } from '../nova_plugin/game_data_resource.js';
import { PlayerSoundEvent, SoundEvent, SoundEventData } from '../nova_plugin/sound_plugin.js';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin.js';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { PREWARM_UI_SOUNDS, UiSoundEvent } from './ui_sound.js';

const LoopingSounds = new Resource<Map<string, Sound>>('LoopingSounds');
const VolumeResource = new Resource<{volume: number}>('VolumeResource');

function playSound({ id, loop, stop }: SoundEventData,
    displayAssets: DisplayAssetDataInterface,
    loopingSounds: Map<string, Sound>, volume: number) {
    if (stop) {
        // Cut the sound off (e.g. the warp-up must not ring out over
        // the system the ship just jumped into).
        displayAssets.data.Sound.getCached(id)?.stop();
        loopingSounds.delete(id);
        return;
    }
    if (loop && loopingSounds.has(id)) {
        return;
    }

    const maybeSound = displayAssets.data.Sound.getCached(id);
    if (maybeSound) {
        maybeSound.volume = volume;
        if (loop) {
            loopingSounds.set(id, maybeSound);
            maybeSound.play(() => {
                loopingSounds.delete(id);
            });
        } else {
            maybeSound.play();
        }
    }
}

const SoundSystem = new System({
    name: 'SoundSystem',
    events: [SoundEvent],
    args: [SoundEvent, DisplayAssetDataResource, LoopingSounds, VolumeResource,
           SingletonComponent] as const,
    step(sound, displayAssets, loopingSounds, {volume}) {
        playSound(sound, displayAssets, loopingSounds, volume);
    }
});

/**
 * Plays sounds meant only for the local player's own ship (hyperspace
 * warp-up/warp-out). PlayerSoundEvent is emitted targeted at the
 * originating ship, so this system runs only when that ship carries
 * the local PlayerShipSelector marker — other ships' jumps are silent
 * here, the same filter the jump flash overlay uses. Exported for
 * tests.
 */
export const PlayerSoundSystem = new System({
    name: 'PlayerSoundSystem',
    events: [PlayerSoundEvent],
    args: [PlayerSoundEvent, DisplayAssetDataResource, LoopingSounds,
        VolumeResource, PlayerShipSelector] as const,
    step(sound, displayAssets, loopingSounds, {volume}) {
        playSound(sound, displayAssets, loopingSounds, volume);
    }
});

/**
 * Plays the local UI/space sounds (interface beeps, first-hostile, the
 * explosion loop, boarding). UiSoundEvent is a display-only channel — never
 * bridged to peers — so this is the single place those client-local cues are
 * turned into audio, reusing the same loop/stop/volume machinery as the
 * networked channels. Exported for tests.
 */
export const UiSoundSystem = new System({
    name: 'UiSoundSystem',
    events: [UiSoundEvent],
    args: [UiSoundEvent, DisplayAssetDataResource, LoopingSounds, VolumeResource,
           SingletonComponent] as const,
    step(sound, displayAssets, loopingSounds, {volume}) {
        playSound(sound, displayAssets, loopingSounds, volume);
    }
});

export const SoundPlugin: Plugin = {
    name: 'SoundPlugin',
    build(world) {
        world.resources.set(LoopingSounds, new Map());
        world.resources.set(VolumeResource, {volume: 0.045});
        world.addSystem(SoundSystem);
        world.addSystem(PlayerSoundSystem);
        world.addSystem(UiSoundSystem);

        // Pre-warm the static UI/space sounds so the first beep/cue isn't
        // silent while the asset streams in (playSound reads getCached).
        const displayAssets = world.resources.get(DisplayAssetDataResource);
        for (const id of PREWARM_UI_SOUNDS) {
            displayAssets?.data.Sound.get(id);
        }
    },
    remove(world) {
        world.removeSystem(UiSoundSystem);
        world.removeSystem(PlayerSoundSystem);
        world.removeSystem(SoundSystem);
        world.resources.delete(VolumeResource);
        world.resources.delete(LoopingSounds);
    }
}
