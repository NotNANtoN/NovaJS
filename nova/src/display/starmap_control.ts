import type { ControlEvent } from '../nova_plugin/controls_plugin';

export interface StarmapControlTarget {
    readonly container: {
        readonly visible: boolean;
        readonly position: {
            set(x: number, y: number): unknown;
        };
    };
    setExploredSystems(exploredSystems?: readonly string[]): void;
    show(route: string[]): Promise<string[]>;
}

export interface MapJumpRoute {
    route: string[];
}

export interface MapScreenSize {
    x: number;
    y: number;
}

export interface MapPlayerState {
    exploredSystems?: readonly string[];
}

export function isMapStartEdge(
    controlEvent: readonly ControlEvent[],
    mapVisible: boolean,
): boolean {
    return !mapVisible && controlEvent.some(({ action, state }) =>
        action === 'map' && state === 'start');
}

export async function handleMapControlEvent(
    controlEvent: readonly ControlEvent[],
    starmap: StarmapControlTarget,
    jumpRoute: MapJumpRoute,
    screenSize: MapScreenSize,
    playerState: MapPlayerState | undefined,
): Promise<void> {
    if (!isMapStartEdge(controlEvent, starmap.container.visible)) {
        return;
    }
    starmap.container.position.set(screenSize.x / 2, screenSize.y / 2);
    starmap.setExploredSystems(playerState?.exploredSystems);
    jumpRoute.route = await starmap.show(jumpRoute.route);
}
