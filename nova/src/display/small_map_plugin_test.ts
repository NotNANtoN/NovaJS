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
                    { uuid: 'enemy-1', pos: { x: 3000, y: -2000 }, isPlayer: false, isEscort: false, isHostile: true },
                ],
                [
                    { uuid: 'earth', name: 'Earth', pos: { x: 0, y: 0 } },
                ],
            );
        }).not.toThrow();
    });
});
