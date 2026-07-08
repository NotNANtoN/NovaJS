import { Sound } from '@pixi/sound';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { DisplayAssetDataResource } from '../nova_plugin/game_data_resource.js';
import { PlayerSoundEvent, SoundEvent } from '../nova_plugin/sound_plugin.js';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin.js';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';

const LoopingSounds = new Resource<Map<string, Sound>>('LoopingSounds');
const VolumeResource = new Resource<{volume: number}>('VolumeResource');

function playSound(id: string, loop: boolean | undefined,
    displayAssets: DisplayAssetDataInterface,
    loopingSounds: Map<string, Sound>, volume: number) {
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
    step({ id, loop }, displayAssets, loopingSounds, {volume}) {
        playSound(id, loop, displayAssets, loopingSounds, volume);
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
    step({ id, loop }, displayAssets, loopingSounds, {volume}) {
        playSound(id, loop, displayAssets, loopingSounds, volume);
    }
});

export const SoundPlugin: Plugin = {
    name: 'SoundPlugin',
    build(world) {
        world.resources.set(LoopingSounds, new Map());
        world.resources.set(VolumeResource, {volume: 0.045});
        world.addSystem(SoundSystem);
        world.addSystem(PlayerSoundSystem);
    },
    remove(world) {
        world.removeSystem(PlayerSoundSystem);
        world.removeSystem(SoundSystem);
        world.resources.delete(VolumeResource);
        world.resources.delete(LoopingSounds);
    }
}
