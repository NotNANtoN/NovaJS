import 'jasmine';
import {
    advanceExplosionTiming,
    explosionFrameDurationMs,
} from './explosion_timing';
import {
    completeDestructionVisual,
    registerDestructionVisual,
} from './destruction_visual_state';
import { AnimationGraphic } from './animation_graphic';
import { AnimationGraphicComponent } from './animation_graphic_plugin';
import { Time } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { Position } from 'nova_ecs/datatypes/position';
import { getDefaultExplosionData } from 'novadatainterface/ExplosionData';
import {
    ExplosionSystem,
    makeExplosion,
    PlayerDestructionVisualFallbackSystem,
    ShipFinalExplosionSystem,
    TrackDyingShips,
} from './explosion_plugin';
import { Entity } from 'nova_ecs/entity';
import { PlayerDeathState } from '../nova_plugin/death_plugin';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { EntityBudget } from '../nova_plugin/entity_budget';

describe('explosion presentation cadence', () => {
    it('converts retail FrameAdvance factors to 30 Hz frame durations', () => {
        expect(explosionFrameDurationMs(1)).toBeCloseTo(1000 / 30, 8);
        expect(explosionFrameDurationMs(0.5)).toBeCloseTo(2000 / 30, 8);
        expect(explosionFrameDurationMs(0.3)).toBeCloseTo(1000 / 9, 8);
    });

    it('advances from render time and completes exactly after its last frame', () => {
        const state = {};
        expect(advanceExplosionTiming(state, 0, 4, 1))
            .toEqual({ progress: 0, done: false });
        expect(advanceExplosionTiming(state, 1000 / 60, 4, 1).progress)
            .toBeCloseTo(0.125, 8);
        expect(advanceExplosionTiming(state, 1000 / 30, 4, 1))
            .toEqual(jasmine.objectContaining({
                progress: jasmine.any(Number),
                done: false,
            }));
        expect(advanceExplosionTiming(state, 1000 / 30, 4, 1).progress)
            .toBeCloseTo(0.25, 8);
        expect(advanceExplosionTiming(state, 4 * 1000 / 30, 4, 1))
            .toEqual({ progress: 1, done: true });
    });

    it('completes destruction after every primary and secondary visual', () => {
        const active = new Map<string, number>();
        registerDestructionVisual(active, 'player');
        registerDestructionVisual(active, 'player');
        registerDestructionVisual(active, 'player');

        expect(completeDestructionVisual(active, 'player')).toBeFalse();
        expect(completeDestructionVisual(active, 'player')).toBeFalse();
        expect(completeDestructionVisual(active, 'player')).toBeTrue();
        expect(active.has('player')).toBeFalse();
    });

    it('keeps the entity through the animation lifetime', () => {
        const explosionData = getDefaultExplosionData();
        explosionData.animation.images.baseImage.frames.normal.length = 4;
        const explosion = makeExplosion(
            explosionData,
            new Position(0, 0),
        );
        const world = new World('explosion-lifetime-test');
        world.entities.set('explosion', explosion);
        let progress = -1;
        const graphic = {
            sprites: new Map([['baseImage', { frames: 1 }]]),
            get progress() {
                return progress;
            },
            set progress(value: number) {
                progress = value;
            },
        } as unknown as AnimationGraphic;
        explosion.addComponent(AnimationGraphicComponent, graphic);
        const state = explosion.componentsByName.get('ExplosionState') as {
            startTime?: number,
            lifetime?: number,
        };
        const time: Time = {
            time: 0,
            delta_ms: 0,
            delta_s: 0,
            frame: 0,
        };
        const step = () => ExplosionSystem.step(
            graphic,
            explosionData,
            state,
            time,
            world.entities,
            'explosion',
            world.emit.bind(world),
            new Map(),
            { position: new Position(0, 0) } as never,
            undefined,
        );

        step();
        expect(world.entities.has('explosion')).toBeTrue();
        time.time = state.lifetime! + 1;
        step();
        expect(world.entities.has('explosion')).toBeTrue();
        time.time += 1;
        step();
        expect(world.entities.has('explosion')).toBeFalse();
    });

    it('sends a killed pilot onward even if the visual never finishes', () => {
        // The return to the main menu hangs off this announcement, so a sprite
        // sheet that never loads must not strand the pilot at the wreck.
        const death: PlayerDeathState = {
            wreckPosition: [0, 0],
            visualFallbackAt: 5_000,
            outcome: 'killed',
        };
        const entity = new Entity('wreck');
        const active = new Map<string, number>();
        registerDestructionVisual(active, 'player');
        const emitted: Array<{ playerUuid: string }> = [];
        const time: Time = { time: 0, delta_ms: 0, delta_s: 0, frame: 0 };
        const emit = ((_event: unknown, value: { playerUuid: string }) =>
            emitted.push(value)) as never;
        const step = () => PlayerDestructionVisualFallbackSystem.step(
            death, time, 'player', emit, entity, active,
            entity.componentsByName.get('DestructionFallbackFired') as
                true | undefined,
        );

        step();
        expect(emitted.length).toBe(0);

        time.time = 5_000;
        step();
        expect(emitted).toEqual([
            jasmine.objectContaining({ playerUuid: 'player', time: 5_000 }),
        ]);
        // A late-finishing explosion must not announce the same death twice.
        expect(active.has('player')).toBeFalse();

        step();
        expect(emitted.length).toBe(1);
    });

    it('leaves an escaped pilot to the escape-pod respawn', () => {
        const death: PlayerDeathState = {
            wreckPosition: [0, 0],
            visualFallbackAt: 0,
            outcome: 'escaped',
        };
        const emitted: unknown[] = [];
        PlayerDestructionVisualFallbackSystem.step(
            death,
            { time: 10_000, delta_ms: 0, delta_s: 0, frame: 0 },
            'player',
            ((_event: unknown, value: unknown) => emitted.push(value)) as never,
            new Entity('wreck'),
            new Map(),
            undefined,
        );
        expect(emitted.length).toBe(0);
    });

    it('explodes a wreck the server has already removed', () => {
        // A client never sees DeathEvent, because damage and death are
        // resolved on the server. The wreck disappearing is its only notice.
        const explosionData = getDefaultExplosionData();
        const ship = getDefaultShipData();
        ship.finalExplosion = 'nova:128';
        const gameData = {
            data: { Explosion: { getCached: () => explosionData } },
        };
        const world = new World('wreck-removal-test');
        const dying = new Map();
        const movement = { position: new Position(120, -40) };

        TrackDyingShips.step(ship, true, movement as never, 'wreck', dying,
            undefined);
        expect(dying.get('wreck').position)
            .toEqual(new Position(120, -40));

        // Still flying: nothing to play yet.
        world.entities.set('wreck', makeExplosion(
            explosionData, new Position(0, 0)));
        ShipFinalExplosionSystem.step(world.entities, dying,
            gameData as never, new EntityBudget(), new Map(), undefined);
        expect(dying.has('wreck')).toBeTrue();

        const before = world.entities.size;
        world.entities.delete('wreck');
        ShipFinalExplosionSystem.step(world.entities, dying,
            gameData as never, new EntityBudget(), new Map(), undefined);
        expect(dying.has('wreck')).toBeFalse();
        expect([...world.entities.keys()].filter(key => key !== 'wreck').length)
            .toEqual(before);
    });
});
