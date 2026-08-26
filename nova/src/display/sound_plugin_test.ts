import 'jasmine';
import { EmitFunction } from 'nova_ecs/arg_types';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState } from 'nova_ecs/plugins/movement_plugin';
import { Stat } from '../nova_plugin/stat';
import {
    HEALTH_HIT_SOUND_COOLDOWN_MS,
    HealthSoundState,
    IncomingMissileWarningSystem,
    LandingSoundRequestSystem,
    PlayerHealthSoundSystem,
    StellarSoundSystem,
    TargetSelectionSoundSystem,
} from './sound_plugin';
import {
    HEALTH_HIT_SOUND_ID,
    INCOMING_MISSILE_SOUND_ID,
    SoundEvent,
    STELLAR_DOCKING_SOUND_ID,
    STELLAR_DEPARTURE_SOUND_ID,
    TARGET_SELECTION_SOUND_ID,
} from '../nova_plugin/sound_event';
import { getDefaultProjectileWeaponData } from
    'novadatainterface/WeaponData';

function soundCollector() {
    const sounds: string[] = [];
    const emit: EmitFunction = (event, data) => {
        if ((event as unknown) === SoundEvent) {
            sounds.push((data as { id: string }).id);
        }
    };
    return {sounds, emit};
}

function movement(
    x: number,
    y: number,
    velocityX: number,
    velocityY: number,
): MovementState {
    return {
        position: new Position(x, y),
        velocity: new Vector(velocityX, velocityY),
        rotation: new Angle(0),
        turning: 0,
        turnBack: false,
        accelerating: 0,
    };
}

describe('browser sound effects', () => {
    it('plays one health sound for a replicated drop, not once per frame', () => {
        const {sounds, emit} = soundCollector();
        const shield = new Stat({current: 100, max: 100, recharge: 0});
        const armor = new Stat({current: 100, max: 100, recharge: 0});
        const players = [['player', undefined, shield, armor]];
        const state: HealthSoundState = {lastPlayedAt: -Infinity};
        const time = {time: 100, delta_ms: 0, delta_s: 0, frame: 0};

        PlayerHealthSoundSystem.step(
            players as never, time, state, emit, undefined);
        shield.current = 80;
        PlayerHealthSoundSystem.step(
            players as never, time, state, emit, undefined);
        time.time += HEALTH_HIT_SOUND_COOLDOWN_MS / 2;
        PlayerHealthSoundSystem.step(
            players as never, time, state, emit, undefined);

        expect(sounds).toEqual([HEALTH_HIT_SOUND_ID]);
    });

    it('plays a sound when a target is selected', () => {
        const {sounds, emit} = soundCollector();

        TargetSelectionSoundSystem.step(
            {target: 'hostile'}, emit, undefined);

        expect(sounds).toEqual([TARGET_SELECTION_SOUND_ID]);
    });

    it('warns once for an inbound guided missile', () => {
        const {sounds, emit} = soundCollector();
        const projectileData = getDefaultProjectileWeaponData();
        projectileData.guidance = 'guided';
        const projectiles = [[
            'missile',
            {id: projectileData.id},
            projectileData,
            {target: 'player'},
            {owner: 'hostile'},
            movement(100, 0, -10, 0),
            undefined,
        ]];
        const players = [['player', undefined, movement(0, 0, 0, 0)]];
        const warned = new Set<string>();

        IncomingMissileWarningSystem.step(
            projectiles as never, players as never, warned, emit, undefined);
        IncomingMissileWarningSystem.step(
            projectiles as never, players as never, warned, emit, undefined);

        expect(sounds).toEqual([INCOMING_MISSILE_SOUND_ID]);
    });

    it('does not warn for a guided projectile moving away from the player', () => {
        const {sounds, emit} = soundCollector();
        const projectileData = getDefaultProjectileWeaponData();
        projectileData.guidance = 'guided';
        const projectiles = [[
            'missile',
            {id: projectileData.id},
            projectileData,
            {target: 'player'},
            {owner: 'hostile'},
            movement(100, 0, 10, 0),
            undefined,
        ]];
        const players = [['player', undefined, movement(0, 0, 0, 0)]];

        IncomingMissileWarningSystem.step(
            projectiles as never, players as never, new Set(), emit, undefined);

        expect(sounds).toEqual([]);
    });

    it('uses the retail airlock sound on docking and departure', () => {
        const {sounds, emit} = soundCollector();
        const state = {
            pendingLanding: false,
            awaitingDeparture: false,
            playerWasPresent: true,
        };

        LandingSoundRequestSystem.step(
            {id: 'nova:128', uuid: 'player'}, state, undefined);
        StellarSoundSystem.step([], state, emit, undefined);
        StellarSoundSystem.step([], state, emit, undefined);
        StellarSoundSystem.step([[undefined]], state, emit, undefined);

        expect(sounds).toEqual([
            STELLAR_DOCKING_SOUND_ID,
            STELLAR_DEPARTURE_SOUND_ID,
        ]);
    });
});
