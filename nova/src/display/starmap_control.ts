import { plainSnapshot } from 'nova_ecs/draft_snapshot';
import type { ControlEvent } from '../nova_plugin/controls_plugin';
import type { StarmapPlayerState } from '../spaceport/starmap_state';
import type { StarmapPlayerMarker } from '../spaceport/starmap';

export interface StarmapControlTarget {
    readonly container: {
        readonly visible: boolean;
        readonly position: {
            set(x: number, y: number): unknown;
        };
    };
    setExploredSystems(exploredSystems?: readonly string[]): void;
    setPlayerState?(playerState?: StarmapPlayerState): void;
    setPlayerMarkers?(playerMarkers?: readonly StarmapPlayerMarker[]): void;
    show(route: string[]): Promise<string[]>;
}

export interface MapJumpRoute {
    route: string[];
}

export interface MapScreenSize {
    x: number;
    y: number;
}

export type MapPlayerState = StarmapPlayerState;

export function isMapStartEdge(
    controlEvent: readonly ControlEvent[],
    mapVisible: boolean,
): boolean {
    return !mapVisible && controlEvent.some(({ action, state }) =>
        action === 'map' && state === 'start');
}

/**
 * The map stays open across many world steps, so nothing read out of a
 * component may be kept: the pilot state is handed over as a copy, and the
 * chosen route is written through `applyRoute`, which resolves the component
 * again after the map closes. Assigning to the `jumpRoute` read on the way in
 * would throw on a revoked draft and lose the route with it.
 */
export async function handleMapControlEvent(
    controlEvent: readonly ControlEvent[],
    starmap: StarmapControlTarget,
    jumpRoute: MapJumpRoute,
    screenSize: MapScreenSize,
    playerState: MapPlayerState | undefined,
    applyRoute: (route: string[]) => void = route => {
        jumpRoute.route = route;
    },
    playerMarkers?: readonly StarmapPlayerMarker[],
): Promise<void> {
    if (!isMapStartEdge(controlEvent, starmap.container.visible)) {
        return;
    }
    starmap.container.position.set(screenSize.x / 2, screenSize.y / 2);
    const state = plainSnapshot(playerState);
    starmap.setPlayerState?.(state);
    starmap.setExploredSystems(state?.exploredSystems);
    starmap.setPlayerMarkers?.(playerMarkers);
    applyRoute(await starmap.show([...jumpRoute.route]));
}
