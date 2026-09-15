import 'jasmine';
import { World } from 'nova_ecs/world';
import { SmallMap, SmallMapControlSystem, SmallMapResource } from './small_map_plugin';
import { EcsControlEvent } from '../nova_plugin/controls_plugin';

describe('SmallMap', () => {
    it('initializes hidden and toggles visibility', () => {
        const smallMap = new SmallMap();
        expect(smallMap.visible).toBeFalse();

        smallMap.toggle();
        expect(smallMap.visible).toBeTrue();

        smallMap.toggle();
        expect(smallMap.visible).toBeFalse();
    });

    it('cycles radar range modes across 5k, 10k, and 25k units', () => {
        const smallMap = new SmallMap();
        expect(smallMap.currentRange).toBe(10_000);

        expect(smallMap.cycleRange()).toBe(25_000);
        expect(smallMap.currentRange).toBe(25_000);

        expect(smallMap.cycleRange()).toBe(5_000);
        expect(smallMap.currentRange).toBe(5_000);

        expect(smallMap.cycleRange()).toBe(10_000);
        expect(smallMap.currentRange).toBe(10_000);
    });

    it('toggles visibility upon smallMap control event', () => {
        const world = new World('small-map-control-test');
        const smallMap = new SmallMap();
        world.resources.set(SmallMapResource, smallMap);
        world.addSystem(SmallMapControlSystem);

        world.emitNow(EcsControlEvent, [{ action: 'smallMap', state: 'start' }]);
        expect(smallMap.visible).toBeTrue();

        world.emitNow(EcsControlEvent, [{ action: 'smallMap', state: 'start' }]);
        expect(smallMap.visible).toBeFalse();
    });

    it('renders tactical blips without throwing', () => {
        const smallMap = new SmallMap();
        expect(() => {
            smallMap.renderTacticalState(
                { x: 1000, y: -500 },
                0.5,
                'target-1',
                ['nova:128'],
                [
                    { uuid: 'target-1', pos: { x: 2000, y: -1000 }, isPlayer: true, isEscort: false, isHostile: false },
                    { uuid: 'escort-1', pos: { x: 900, y: -600 }, isPlayer: false, isEscort: true, isHostile: false },
                    { uuid: 'enemy-1', pos: { x: 3000, y: -2000 }, isPlayer: false, isEscort: false, isHostile: true, isMission: true },
                ],
                [
                    { uuid: 'earth', name: 'Earth', pos: { x: 0, y: 0 } },
                ],
                0,
                [
                    { uuid: 'ore-1', pos: { x: 1200, y: -450 } },
                ],
            );
        }).not.toThrow();
    });
});
