import { Sound } from '@pixi/sound';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { GameData } from '../client/gamedata/GameData';
import { EcsControlEvent } from '../nova_plugin/controls_plugin';
import { GameDataResource } from '../nova_plugin/game_data_resource';
import { SoundEvent } from '../nova_plugin/sound_event';
import {
    MASTER_VOLUME_STEP,
    getMasterVolume,
    setMasterVolume,
} from './music';

const LoopingSounds = new Resource<Map<string, Sound>>('LoopingSounds');
const LoadedSounds = new Resource<Map<string, Sound>>('LoadedSounds');
const PendingSounds = new Resource<Map<string, Promise<Sound>>>('PendingSounds');
export const VolumeResource = new Resource<{volume: number}>('VolumeResource');

function playLoadedSound(sound: Sound, id: string, loop: boolean,
    loopingSounds: Map<string, Sound>, volume: number) {
    if (loop && loopingSounds.has(id)) {
        return;
    }

    sound.volume = volume;
    if (loop) {
        loopingSounds.set(id, sound);
    }

    const complete = () => {
        if (loopingSounds.get(id) === sound) {
            loopingSounds.delete(id);
        }
    };

    try {
        const playback = sound.play({
            loop,
            complete,
        });
        if (playback instanceof Promise) {
            void playback.catch(error => {
                complete();
                console.warn(`Unable to play sound ${id}`, error);
            });
        }
    } catch (error) {
        complete();
        console.warn(`Unable to play sound ${id}`, error);
    }
}

const SoundSystem = new System({
    name: 'SoundSystem',
    events: [SoundEvent],
    args: [SoundEvent, GameDataResource, LoopingSounds, LoadedSounds,
        PendingSounds, VolumeResource, SingletonComponent] as const,
    step({ id, loop = false }, gameData, loopingSounds, loadedSounds,
        pendingSounds, {volume}) {
        if (loop && loopingSounds.has(id)) {
            return;
        }

        const maybeSound = (gameData as GameData).data.Sound.getCached(id);
        if (maybeSound) {
            loadedSounds.set(id, maybeSound);
            playLoadedSound(maybeSound, id, loop, loopingSounds, volume);
            return;
        }

        let pending = pendingSounds.get(id);
        if (!pending) {
            pending = (gameData as GameData).data.Sound.get(id);
            pendingSounds.set(id, pending);
        }

        void pending.then(sound => {
            loadedSounds.set(id, sound);
            playLoadedSound(sound, id, loop, loopingSounds,
                getMasterVolume());
        }).catch(error => {
            console.warn(`Unable to load sound ${id}`, error);
        }).finally(() => {
            if (pendingSounds.get(id) === pending) {
                pendingSounds.delete(id);
            }
        });
    }
});

const VolumeControlSystem = new System({
    name: 'VolumeControlSystem',
    events: [EcsControlEvent],
    args: [EcsControlEvent, LoadedSounds, VolumeResource,
        SingletonComponent] as const,
    step(events, loadedSounds, volume) {
        let delta = 0;
        for (const event of events) {
            if (event.state === false) {
                continue;
            }
            if (event.action === 'volumeUp') {
                delta += MASTER_VOLUME_STEP;
            } else if (event.action === 'volumeDown') {
                delta -= MASTER_VOLUME_STEP;
            }
        }

        if (delta === 0) {
            return;
        }

        volume.volume = setMasterVolume(volume.volume + delta);
        for (const sound of loadedSounds.values()) {
            sound.volume = volume.volume;
        }
    }
});

export const SoundPlugin: Plugin = {
    name: 'SoundPlugin',
    build(world) {
        world.resources.set(LoopingSounds, new Map());
        world.resources.set(LoadedSounds, new Map());
        world.resources.set(PendingSounds, new Map());
        world.resources.set(VolumeResource, {volume: getMasterVolume()});
        world.addSystem(SoundSystem);
        world.addSystem(VolumeControlSystem);
    },
    remove(world) {
        const loopingSounds = world.resources.get(LoopingSounds);
        if (loopingSounds) {
            for (const sound of loopingSounds.values()) {
                sound.stop();
            }
        }
        world.removeSystem(SoundSystem);
        world.removeSystem(VolumeControlSystem);
        world.resources.delete(VolumeResource);
        world.resources.delete(PendingSounds);
        world.resources.delete(LoadedSounds);
        world.resources.delete(LoopingSounds);
    }
}
