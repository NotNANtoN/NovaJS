import 'jasmine';
import {
    shipExplosionBlastRadius,
    shipExplosionBlastStrength,
} from './explosion_plugin';
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
} from './explosion_plugin';

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
});

describe('ship death blast scale', () => {
    it('grows with mass', () => {
        expect(shipExplosionBlastStrength(500)).toBeCloseTo(10, 8);
        expect(shipExplosionBlastRadius(500)).toBeCloseTo(10, 8);
    });

    it('caps the reach of the heaviest hulls', () => {
        // The Leviathan is mass 10,000; an uncapped radius would reach
        // further than the visible screen.
        expect(shipExplosionBlastRadius(10_000)).toEqual(200);
    });

    it('ignores a missing or nonsense mass', () => {
        expect(shipExplosionBlastStrength(0)).toEqual(0);
        expect(shipExplosionBlastRadius(Number.NaN)).toEqual(0);
    });
});
