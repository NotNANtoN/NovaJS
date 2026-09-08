import 'jasmine';
import { createDraft, finishDraft } from 'immer';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { GameDataResource } from '../nova_plugin/game_data_resource';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import { EmitFunction } from 'nova_ecs/arg_types';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState } from 'nova_ecs/plugins/movement_plugin';
import {
    SoundPlugin,
    VolumeResource,
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

describe('queued world sound snapshots', () => {
    it('snapshots a drafted payload including loop metadata before notifying subscribers', () => {
        const world = new World('sound-snapshot');
        const draft = createDraft({
            id: 'nova:302', loop: true, position: { x: 25, y: -50 },
        });
        let received: typeof draft | undefined;
        world.events.get(SoundEvent).subscribe(data => {
            expect(data).not.toBe(draft);
            expect(data.position).not.toBe(draft.position);
            received = data as typeof draft;
        });
        SoundEvent.emit(world.emit.bind(world), draft);
        draft.id = 'nova:150';
        draft.loop = false;
        draft.position.x = 9_000;
        finishDraft(draft);
        world.step();
        expect(received).toEqual({
            id: 'nova:302', loop: true, position: { x: 25, y: -50 },
        });
    });

    it('preserves placeless sounds and isolates ordinary mutable positions', () => {
        const world = new World('sound-values');
        const received: unknown[] = [];
        world.events.get(SoundEvent).subscribe(data => received.push(data));
        const position = { x: 100, y: 200 };
        SoundEvent.emit(world.emit.bind(world), { id: 'world', loop: false, position });
        SoundEvent.emit(world.emit.bind(world), { id: 'ui' });
        position.y = 5_000;
        world.step();
        expect(received).toEqual([
            { id: 'world', loop: false, position: { x: 100, y: 200 } },
            { id: 'ui' },
        ]);
    });

    it('plays a forwarded asteroid impact after its movement draft is revoked', async () => {
        const source = new World('sound-source');
        const listener = new World('sound-listener');
        const play = jasmine.createSpy('play');
        const sound = { volume: 0, play };
        listener.resources.set(GameDataResource, {
            data: { Sound: { getCached: () => sound } },
        } as never);
        await listener.addPlugin(SoundPlugin);
        listener.resources.set(VolumeResource, { volume: 0.8 });
        listener.entities.set('player', new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(MovementStateComponent, movement(0, 0, 0, 0)));
        source.events.get(SoundEvent).subscribe(data => listener.emit(SoundEvent, data));

        const draft = createDraft(movement(2_850, 0, 100, 0));
        SoundEvent.emit(source.emit.bind(source), { id: 'nova:302', position: draft.position });
        // Both queues still hold the impact when delta tracking finishes.
        draft.position.x = 5_000;
        finishDraft(draft);
        expect(() => draft.position.x).toThrow();
        source.step();
        listener.step();

        expect(play).toHaveBeenCalledTimes(1);
        expect(sound.volume).toBeCloseTo(0.4);
    });
});

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
