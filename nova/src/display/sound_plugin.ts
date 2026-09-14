import { Optional } from 'nova_ecs/optional';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { ShieldComponent } from '../nova_plugin/health_plugin';
import { Sound } from '@pixi/sound';
import { Emit, Entities, UUID } from 'nova_ecs/arg_types';
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
import { headingError } from '../nova_plugin/flight_controller';
import { ActiveSecondaryWeapon } from '../nova_plugin/weapon_plugin';
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
const FailedSounds = new Resource<Set<string>>('FailedSounds');
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
        PendingSounds, FailedSounds, VolumeResource, PlayerMovementQuery,
        SingletonComponent] as const,
    step({ id, loop = false, stop = false, position }, gameData, loopingSounds, loadedSounds,
        pendingSounds, failedSounds, {volume: masterVolume}, players) {
        if (stop) {
            loadedSounds.get(id)?.stop();
            loopingSounds.get(id)?.stop();
            loopingSounds.delete(id);
            return;
        }
        if (failedSounds.has(id)) {
            return;
        }
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
                failedSounds.add(id);
                return;
            }
            loadedSounds.set(id, sound);
            playLoadedSound(sound, id, loop, loopingSounds,
                getMasterVolume() * attenuation);
        }).catch(error => {
            failedSounds.add(id);
            console.warn(`Unable to load sound ${id}, using silent fallback`, error);
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
        IncomingMissileStateResource, Emit, SingletonComponent, Optional(TimeResource)] as const,
    step(projectiles, players, warned, emit, _singleton, time) {
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
        let closestDist = Infinity;
        let hasInbound = false;
        for (const [uuid, _projectile, projectileData, target, owner,
            movement] of projectiles) {
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
            hasInbound = true;
            const dist = movement.position.subtract(playerMovement.position).length;
            if (dist < closestDist) closestDist = dist;
            if (!warned.has(uuid)) {
                warned.add(uuid);
                emit(SoundEvent, { id: INCOMING_MISSILE_SOUND_ID });
            }
        }

        if (hasInbound && time && closestDist < Infinity) {
            const lastPing = (warned as any)._lastMissilePing ?? time.time;
            const interval = Math.max(300, Math.min(1500, (closestDist / 800) * 1200));
            if (time.time - lastPing >= interval) {
                (warned as any)._lastMissilePing = time.time;
                emit(SoundEvent, { id: INCOMING_MISSILE_SOUND_ID });
            }
        } else if (!hasInbound) {
            delete (warned as any)._lastMissilePing;
        }
    },
});

export const LowShieldWarningSystem = new System({
    name: 'LowShieldWarningSystem',
    args: [PlayerShipSelector, ShieldComponent, Optional(TimeResource), Emit] as const,
    step(_player, shield, time, emit) {
        if (!time) return;
        if (shield.max > 0 && shield.current > 0 && (shield.current / shield.max) <= 0.25) {
            const lastWarn = (shield as any)._lastLowShieldWarn;
            if (lastWarn === undefined || time.time - lastWarn >= 1800) {
                (shield as any)._lastLowShieldWarn = time.time;
                emit(SoundEvent, { id: 'nova:153' });
            }
        } else if (shield.max > 0 && (shield.current / shield.max) > 0.25) {
            delete (shield as any)._lastLowShieldWarn;
        }
    },
});

export const MissileLockToneSystem = new System({
    name: 'MissileLockToneSystem',
    args: [
        PlayerShipSelector,
        TargetComponent,
        MovementStateComponent,
        Optional(ActiveSecondaryWeapon),
        GameDataResource,
        Entities,
        Emit,
    ] as const,
    step(_player, target, playerMovement, activeSecondary, gameData, entities, emit) {
        const secondaryId = activeSecondary?.secondary;
        if (!secondaryId || !target.target) {
            (target as any)._missileLocked = false;
            return;
        }
        const weaponData = gameData.data.Weapon?.getCached(secondaryId);
        if (!weaponData || weaponData.guidance !== 'guided') {
            (target as any)._missileLocked = false;
            return;
        }
        const targetEntity = entities.get(target.target);
        const targetMovement = targetEntity?.components.get(MovementStateComponent);
        if (!targetMovement) {
            (target as any)._missileLocked = false;
            return;
        }

        const toTarget = targetMovement.position.subtract(playerMovement.position);
        const distance = toTarget.length;
        const speed = weaponData.shotSpeed ?? 300;
        const duration = (('shotDuration' in weaponData ? weaponData.shotDuration : 3000) ?? 3000) / 1000;
        const maxRange = Math.max(800, speed * duration);
        const angleDiff = Math.abs(headingError(playerMovement.rotation, toTarget.angle));

        const hasLock = angleDiff <= (35 * Math.PI / 180) && distance <= maxRange;
        if (hasLock && !(target as any)._missileLocked) {
            (target as any)._missileLocked = true;
            emit(SoundEvent, { id: 'nova:150' });
        } else if (!hasLock) {
            (target as any)._missileLocked = false;
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

export function stopHyperjumpSounds(world?: { resources: { get: (res: any) => any } }): void {
    const loaded = world?.resources?.get(LoadedSounds);
    const looping = world?.resources?.get(LoopingSounds);
    for (const id of ['nova:128', 'nova:123', 'nova:130']) {
        loaded?.get(id)?.stop();
        looping?.get(id)?.stop();
        looping?.delete(id);
    }
}

export const SoundPlugin: Plugin = {
    name: 'SoundPlugin',
    build(world) {
        world.resources.set(LoopingSounds, new Map());
        world.resources.set(LoadedSounds, new Map());
        world.resources.set(PendingSounds, new Map());
        world.resources.set(FailedSounds, new Set());
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
        world.addSystem(LowShieldWarningSystem);
        world.addSystem(MissileLockToneSystem);
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
        world.removeSystem(LowShieldWarningSystem);
        world.removeSystem(MissileLockToneSystem);
        world.removeSystem(LandingSoundRequestSystem);
        world.removeSystem(LandingSoundResultSystem);
        world.removeSystem(StellarSoundSystem);
        world.resources.delete(VolumeResource);
        world.resources.delete(StellarSoundStateResource);
        world.resources.delete(IncomingMissileStateResource);
        world.resources.delete(FailedSounds);
        world.resources.delete(PendingSounds);
        world.resources.delete(LoadedSounds);
        world.resources.delete(LoopingSounds);
    }
}
