import 'jasmine';
import type { ControlEvent } from '../nova_plugin/controls_plugin';
import {
    handleMapControlEvent,
    isMapStartEdge,
} from './starmap_control';

describe('starmap control handling', () => {
    function makeStarmap(visible = false) {
        return {
            container: {
                visible,
                position: { set: jasmine.createSpy('position.set') },
            },
            setExploredSystems: jasmine.createSpy('setExploredSystems'),
            show: jasmine.createSpy('show').and.returnValue(Promise.resolve([])),
        };
    }

    async function runMapControl(
        controlEvent: ControlEvent[],
        starmap: ReturnType<typeof makeStarmap>,
        route: string[] = [],
    ) {
        const jumpRoute = { route };
        await handleMapControlEvent(
            controlEvent, starmap, jumpRoute, { x: 800, y: 600 }, undefined);
        return jumpRoute.route;
    }

    it('recognizes only a hidden map start as an opening edge', () => {
        expect(isMapStartEdge(
            [{ action: 'accelerate', state: 'start' }], false,
        )).toBeFalse();
        expect(isMapStartEdge(
            [{ action: 'map', state: 'start' }], false,
        )).toBeTrue();
        expect(isMapStartEdge(
            [{ action: 'map', state: 'start' }], true,
        )).toBeFalse();
    });

    it('does not touch the starmap for non-map controls', async () => {
        const starmap = makeStarmap();
        await runMapControl(
            [{ action: 'turnLeft', state: 'start' }],
            starmap,
        );

        expect(starmap.setExploredSystems).not.toHaveBeenCalled();
        expect(starmap.container.position.set).not.toHaveBeenCalled();
        expect(starmap.show).not.toHaveBeenCalled();
    });

    it('updates and opens the starmap on the map start edge', async () => {
        const starmap = makeStarmap();
        await runMapControl(
            [{ action: 'map', state: 'start' }],
            starmap,
        );

        expect(starmap.setExploredSystems).toHaveBeenCalledWith(undefined);
        expect(starmap.container.position.set).toHaveBeenCalledWith(400, 300);
        expect(starmap.show).toHaveBeenCalledWith([]);
    });

    it('passes the remaining multi-hop route through a reopen', async () => {
        const starmap = makeStarmap();
        const remaining = ['nova:132', 'nova:138'];
        starmap.show.and.returnValue(Promise.resolve(remaining));

        const result = await runMapControl(
            [{ action: 'map', state: 'start' }],
            starmap,
            remaining,
        );

        expect(starmap.show).toHaveBeenCalledWith(remaining);
        expect(result).toEqual(remaining);
    });
});
