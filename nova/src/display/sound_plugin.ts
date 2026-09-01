import { Sound } from '@pixi/sound';
import { Emit, UUID } from 'nova_ecs/arg_types';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { MovementState, MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { GameData } from '../client/gamedata/GameData';
import { EcsControlEvent } from '../nova_plugin/controls_plugin';
import { GameDataResource } from '../nova_plugin/game_data_resource';
import { LandEvent, LandingResultEvent } from '../nova_plugin/planet_plugin';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import { OwnerComponent, VulnerableToPD } from '../nova_plugin/fire_weapon_plugin';
import { ShipComponent } from '../nova_plugin/ship_plugin';
import {
    ProjectileComponent,
    ProjectileDataComponent,
} from '../nova_plugin/projectile_data';
import { CycleTargetEvent } from '../nova_plugin/target_plugin';
import { TargetComponent } from '../nova_plugin/target_component';
import {
    INCOMING_MISSILE_SOUND_ID,
    SoundEvent,
    STELLAR_DEPARTURE_SOUND_ID,
    STELLAR_DOCKING_SOUND_ID,
    TARGET_SELECTION_SOUND_ID,
} from '../nova_plugin/sound_event';
import { worldSoundVolume } from './sound_attenuation';
import {
    MASTER_VOLUME_STEP,
    getMasterVolume,
    setMasterVolume,
} from './music';

const LoopingSounds = new Resource<Map<string, Sound>>('LoopingSounds');
const LoadedSounds = new Resource<Map<string, Sound>>('LoadedSounds');
const PendingSounds = new Resource<Map<string, Promise<Sound>>>('PendingSounds');
export const VolumeResource = new Resource<{volume: number}>('VolumeResource');
const IncomingMissileStateResource = new Resource<Set<string>>(
    'IncomingMissileState');
const StellarSoundStateResource = new Resource<StellarSoundState>(
    'StellarSoundState');

export interface IncomingMissileSnapshot {
    target: string | undefined;
    owner: string;
    guidance: string;
    vulnerableToPointDefense: boolean;
    position: { x: number, y: number };
    velocity: { x: number, y: number };
}

export function isInboundMissile(
    missile: IncomingMissileSnapshot,
    playerUuid: string,
    playerMovement: Pick<MovementState, 'position' | 'velocity'>,
): boolean {
    if (missile.target !== playerUuid
        || missile.owner === playerUuid
        || missile.guidance !== 'guided'
        || !missile.vulnerableToPointDefense) {
        return false;
    }

    const toPlayerX = playerMovement.position.x - missile.position.x;
    const toPlayerY = playerMovement.position.y - missile.position.y;
    if (toPlayerX ** 2 + toPlayerY ** 2 === 0) {
        return false;
    }

    const relativeVelocityX =
        missile.velocity.x - playerMovement.velocity.x;
    const relativeVelocityY =
        missile.velocity.y - playerMovement.velocity.y;
    return relativeVelocityX * toPlayerX + relativeVelocityY * toPlayerY > 0;
}

interface StellarSoundState {
    pendingLanding: boolean;
    awaitingDeparture: boolean;
    playerWasPresent: boolean;
}

const PlayerMovementQuery = new Query([
    UUID,
    PlayerShipSelector,
    MovementStateComponent,
] as const);
const PlayerPresenceQuery = new Query([
    PlayerShipSelector,
] as const);
const IncomingProjectileQuery = new Query([
    UUID,
    ProjectileComponent,
    ProjectileDataComponent,
    TargetComponent,
    OwnerComponent,
    MovementStateComponent,
    VulnerableToPD,
] as const);

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
        PendingSounds, VolumeResource, PlayerMovementQuery,
        SingletonComponent] as const,
    step({ id, loop = false, position }, gameData, loopingSounds, loadedSounds,
        pendingSounds, {volume: masterVolume}, players) {
        if (loop && loopingSounds.has(id)) {
            return;
        }

        const attenuation = worldSoundVolume(
            1, position, players[0]?.[2].position);
        const volume = masterVolume * attenuation;
        if (volume <= 0) {
            // Too far away to hear, so do not even fetch the sound.
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
            if (!sound) {
                return;
            }
            loadedSounds.set(id, sound);
            playLoadedSound(sound, id, loop, loopingSounds,
                getMasterVolume() * attenuation);
        }).catch(error => {
            console.warn(`Unable to load sound ${id}`, error);
        }).finally(() => {
            if (pendingSounds.get(id) === pending) {
                pendingSounds.delete(id);
            }
        });
    }
});

export const TargetSelectionSoundSystem = new System({
    name: 'TargetSelectionSoundSystem',
    events: [CycleTargetEvent],
    args: [CycleTargetEvent, Emit, SingletonComponent] as const,
    step({target}, emit) {
        if (target) {
            emit(SoundEvent, {id: TARGET_SELECTION_SOUND_ID});
        }
    },
});

export const IncomingMissileWarningSystem = new System({
    name: 'IncomingMissileWarningSystem',
    args: [IncomingProjectileQuery, PlayerMovementQuery,
        IncomingMissileStateResource, Emit, SingletonComponent] as const,
    step(projectiles, players, warned, emit) {
        const active = new Set(projectiles.map(([uuid]) => uuid));
        for (const uuid of warned) {
            if (!active.has(uuid)) {
                warned.delete(uuid);
            }
        }

        const player = players[0];
        if (!player) {
            return;
        }
        const [playerUuid, _player, playerMovement] = player;
        for (const [uuid, _projectile, projectileData, target, owner,
            movement] of projectiles) {
            if (warned.has(uuid)) {
                continue;
            }
            if (!isInboundMissile({
                target: target.target,
                owner: owner.owner,
                guidance: projectileData.guidance,
                vulnerableToPointDefense: true,
                position: movement.position,
                velocity: movement.velocity,
            }, playerUuid, playerMovement)) {
                continue;
            }
            warned.add(uuid);
            emit(SoundEvent, {id: INCOMING_MISSILE_SOUND_ID});
        }
    },
});

export const LandingSoundRequestSystem = new System({
    name: 'LandingSoundRequestSystem',
    events: [LandEvent],
    args: [LandEvent, StellarSoundStateResource, SingletonComponent] as const,
    step(_land, state) {
        state.pendingLanding = true;
    },
});

const LandingSoundResultSystem = new System({
    name: 'LandingSoundResultSystem',
    events: [LandingResultEvent],
    args: [LandingResultEvent, StellarSoundStateResource,
        SingletonComponent] as const,
    step(result, state) {
        if (result.outcome === 'rejected') {
            state.pendingLanding = false;
        }
    },
});

export const StellarSoundSystem = new System({
    name: 'StellarSoundSystem',
    args: [PlayerPresenceQuery, StellarSoundStateResource,
        Emit, SingletonComponent] as const,
    step(players, state, emit) {
        const playerPresent = players.length > 0;
        if (state.pendingLanding && !playerPresent) {
            state.pendingLanding = false;
            state.awaitingDeparture = true;
            state.playerWasPresent = false;
            emit(SoundEvent, {id: STELLAR_DOCKING_SOUND_ID});
            return;
        }

        if (state.awaitingDeparture) {
            if (!playerPresent) {
                state.playerWasPresent = false;
                return;
            }
            if (!state.playerWasPresent) {
                state.awaitingDeparture = false;
                emit(SoundEvent, {id: STELLAR_DEPARTURE_SOUND_ID});
            }
        }
        state.playerWasPresent = playerPresent;
    },
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
        world.resources.set(IncomingMissileStateResource, new Set());
        world.resources.set(StellarSoundStateResource, {
            pendingLanding: false,
            awaitingDeparture: false,
            playerWasPresent: false,
        });
        world.addSystem(SoundSystem);
        world.addSystem(VolumeControlSystem);
        world.addSystem(TargetSelectionSoundSystem);
        world.addSystem(IncomingMissileWarningSystem);
        world.addSystem(LandingSoundRequestSystem);
        world.addSystem(LandingSoundResultSystem);
        world.addSystem(StellarSoundSystem);
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
        world.removeSystem(TargetSelectionSoundSystem);
        world.removeSystem(IncomingMissileWarningSystem);
        world.removeSystem(LandingSoundRequestSystem);
        world.removeSystem(LandingSoundResultSystem);
        world.removeSystem(StellarSoundSystem);
        world.resources.delete(VolumeResource);
        world.resources.delete(StellarSoundStateResource);
        world.resources.delete(IncomingMissileStateResource);
        world.resources.delete(PendingSounds);
        world.resources.delete(LoadedSounds);
        world.resources.delete(LoopingSounds);
    }
}
