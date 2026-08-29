import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { AsteroidComponent } from '../nova_plugin/asteroid_plugin';
import { PlanetComponent } from '../nova_plugin/planet_plugin';
import { ShipComponent } from '../nova_plugin/ship_plugin';
import { AnimationGraphicComponent } from './animation_graphic_plugin';
import {
    flightSceneReadiness,
    isFlightSceneReady,
    waitForFlightScene,
} from './flight_scene_ready';

function ship(id: string, drawn = false): Entity {
    const entity = new Entity();
    entity.components.set(ShipComponent, { id });
    if (drawn) {
        entity.components.set(AnimationGraphicComponent, {} as never);
    }
    return entity;
}

function planet(id: string, drawn = false): Entity {
    const entity = new Entity();
    entity.components.set(PlanetComponent, { id });
    if (drawn) {
        entity.components.set(AnimationGraphicComponent, {} as never);
    }
    return entity;
}

describe('flight scene readiness', () => {
    it('waits for the player hull and every planet in the system', () => {
        const entities = new Map<string, Entity>([
            ['player', ship('nova:128')],
            ['planet nova:128', planet('nova:128', true)],
        ]);
        const notYet = flightSceneReadiness(entities, 'player', 1);
        expect(notYet.playerReady).toBeFalse();
        expect(notYet.planetsReady).toBeTrue();
        expect(isFlightSceneReady(notYet)).toBeFalse();

        entities.set('player', ship('nova:128', true));
        expect(isFlightSceneReady(
            flightSceneReadiness(entities, 'player', 1))).toBeTrue();
    });

    it('keeps the scene closed while a planet sprite is still loading', () => {
        const entities = new Map<string, Entity>([
            ['player', ship('nova:128', true)],
            ['planet nova:128', planet('nova:128')],
            ['planet nova:129', planet('nova:129', true)],
        ]);
        const readiness = flightSceneReadiness(entities, 'player', 2);
        expect(readiness.planetsReady).toBeFalse();
        expect(isFlightSceneReady(readiness)).toBeFalse();
    });

    it('waits for nearby ships and asteroids already in the world', () => {
        const entities = new Map<string, Entity>([
            ['player', ship('nova:128', true)],
            ['planet nova:128', planet('nova:128', true)],
            ['trader', ship('nova:129')],
        ]);
        expect(isFlightSceneReady(
            flightSceneReadiness(entities, 'player', 1))).toBeFalse();

        entities.set('trader', ship('nova:129', true));
        const asteroid = new Entity();
        asteroid.components.set(AsteroidComponent, { id: 'nova:400' } as never);
        asteroid.components.set(AnimationGraphicComponent, {} as never);
        entities.set('roid', asteroid);
        expect(isFlightSceneReady(
            flightSceneReadiness(entities, 'player', 1))).toBeTrue();
    });

    it('pumps until the scene is drawn and the snapshot has had a chance to arrive',
        async () => {
            const entities = new Map<string, Entity>([
                ['player', ship('nova:128')],
            ]);
            let now = 0;
            let steps = 0;
            let snapshotRequested = false;

            const ready = await waitForFlightScene({
                step: () => {
                    steps += 1;
                    if (steps === 1) {
                        snapshotRequested = true;
                    }
                    if (steps === 2) {
                        entities.set('player', ship('nova:128', true));
                        entities.set('planet nova:128', planet('nova:128', true));
                    }
                    if (steps === 4) {
                        entities.set('trader', ship('nova:129', true));
                    }
                },
                entities: () => entities,
                playerUuid: 'player',
                expectedPlanetCount: 1,
                snapshotRequested: () => snapshotRequested,
                now: () => now,
                sleep: async ms => {
                    now += ms;
                },
                timeoutMs: 2_000,
                snapshotGraceMs: 30,
                stableFrames: 2,
            });

            expect(ready).toBeTrue();
            expect(steps).toBeGreaterThanOrEqual(4);
        });
});
