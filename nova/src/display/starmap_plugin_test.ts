import 'jasmine';
import type { ControlEvent } from '../nova_plugin/controls_plugin';
import { createDraft, finishDraft } from 'immer';
import {
    handleMapControlEvent,
    isMapStartEdge,
    MapPlayerState,
} from './starmap_control';

describe('starmap control handling', () => {
    function makeStarmap(visible = false) {
        return {
            container: {
                visible,
                position: { set: jasmine.createSpy('position.set') },
            },
            setExploredSystems: jasmine.createSpy('setExploredSystems'),
            setPlayerState: jasmine.createSpy('setPlayerState'),
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
        expect(starmap.setPlayerState).not.toHaveBeenCalled();
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
        expect(starmap.setPlayerState).toHaveBeenCalledWith(undefined);
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

    it('keeps the pilot state and route usable once the map closes', async () => {
        // The map stays open across many world steps, so the drafts it was
        // opened with are revoked by the time it returns a route.
        const starmap = makeStarmap();
        const chosen = ['nova:140'];
        starmap.show.and.returnValue(Promise.resolve(chosen));
        const playerState = createDraft({
            exploredSystems: ['nova:130'],
        }) as MapPlayerState;
        const jumpRoute = createDraft({ route: ['nova:131'] });
        let applied: string[] | undefined;

        const finished = handleMapControlEvent(
            [{ action: 'map', state: 'start' }],
            starmap,
            jumpRoute,
            { x: 800, y: 600 },
            playerState,
            route => {
                applied = route;
            },
        );
        // End the step the map was opened from.
        finishDraft(playerState);
        finishDraft(jumpRoute);
        await finished;

        expect(applied).toEqual(chosen);
        expect(starmap.show).toHaveBeenCalledWith(['nova:131']);
        // The map was handed a copy, so it can still read it while open.
        const handed = starmap.setPlayerState.calls.mostRecent().args[0];
        expect(handed?.exploredSystems).toEqual(['nova:130']);
    });
});
