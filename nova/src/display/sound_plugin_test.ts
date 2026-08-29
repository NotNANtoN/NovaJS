import 'jasmine';
import { EmitFunction } from 'nova_ecs/arg_types';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState } from 'nova_ecs/plugins/movement_plugin';
import {
    HostileLockWarningSystem,
    IncomingMissileWarningSystem,
    LandingSoundRequestSystem,
    StellarSoundSystem,
    TargetSelectionSoundSystem,
} from './sound_plugin';
import {
    INCOMING_MISSILE_SOUND_ID,
    SoundEvent,
    STELLAR_DOCKING_SOUND_ID,
    STELLAR_DEPARTURE_SOUND_ID,
    TARGET_SELECTION_SOUND_ID,
} from '../nova_plugin/sound_event';
import {
    distanceAttenuation,
    soundDistance,
    worldSoundVolume,
} from './sound_attenuation';
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

    it('warns once when a ship first locks the player', () => {
        const {sounds, emit} = soundCollector();
        const lockers = [['pirate', {target: 'player'}, undefined]];
        const players = [['player', undefined, movement(0, 0, 0, 0)]];
        const warned = new Set<string>();

        HostileLockWarningSystem.step(
            lockers as never, players as never, warned, emit, undefined);
        HostileLockWarningSystem.step(
            lockers as never, players as never, warned, emit, undefined);

        expect(sounds).toEqual([INCOMING_MISSILE_SOUND_ID]);
        expect([...warned]).toEqual(['pirate']);
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

describe('world sound attenuation', () => {
    it('keeps your own ship and the visible area at full volume', () => {
        const here = new Position(1_000, -2_000);
        expect(worldSoundVolume(1, here, here)).toBe(1);
        expect(worldSoundVolume(1, new Position(1_400, -2_000), here)).toBe(1);
    });

    it('silences a ship breaking up on the far side of the system', () => {
        // The complaint this fixes: a distant hull coming apart sounded
        // exactly like the player's own destruction.
        const player = new Position(0, 0);
        expect(worldSoundVolume(1, new Position(5_000, 0), player)).toBe(0);
        const halfway = worldSoundVolume(1, new Position(2_850, 0), player);
        expect(halfway).toBeGreaterThan(0.4);
        expect(halfway).toBeLessThan(0.6);
    });

    it('scales the master volume rather than replacing it', () => {
        const quiet = worldSoundVolume(0.5, new Position(2_850, 0),
            new Position(0, 0));
        expect(quiet).toBeGreaterThan(0.2);
        expect(quiet).toBeLessThan(0.3);
    });

    it('leaves a placeless sound alone', () => {
        // UI beeps and cockpit warnings have no position in the world.
        expect(worldSoundVolume(0.8, undefined, new Position(0, 0))).toBe(0.8);
        expect(worldSoundVolume(0.8, new Position(9_000, 0), undefined))
            .toBe(0.8);
    });

    it('measures across the wrapping edge of the system', () => {
        // Two points either side of the seam are neighbours, not 20000 apart.
        expect(distanceAttenuation(soundDistance(
            { x: -9_900, y: 0 }, { x: 9_900, y: 0 }))).toBe(1);
    });
});
