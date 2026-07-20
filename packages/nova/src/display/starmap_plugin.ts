import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { World } from 'nova_ecs/world';
import { EcsEvent } from 'nova_ecs/events';
import { Subscription } from 'rxjs';
import { DisplayAssetDataResource, SimulationGameDataResource } from '../nova_plugin/game_data_resource.js';
import { ControlsSubject } from '../nova_plugin/controls_plugin.js';
import { JumpRouteComponent } from '../nova_plugin/jump_plugin.js';
import { ControlBitsComponent } from '../nova_plugin/ncb_plugin.js';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin.js';
import { SystemIdResource } from '../nova_plugin/system_id_resource.js';
import { MenuControls } from '../spaceport/menu_controls.js';
import { Starmap } from '../spaceport/starmap.js';
import { ScreenSize } from './screen_size_plugin.js';
import { Stage } from './stage_resource.js';

const StarmapResource = new Resource<Starmap>("Starmap");
const StarmapControlsSubscription = new Resource<Subscription>('StarmapControlsSubscription');
export const SetJumpRouteEvent = new EcsEvent<{ route: string[] }>('SetJumpRouteEvent');
/**
 * Opens the starmap over whatever is on screen and resolves with the
 * chosen route when it closes. Landed menus (the spaceport) call this
 * for their 'map' key; in flight the plugin's own subscription below
 * opens it. No-ops (resolving with the current route) while the map is
 * already open.
 */
export const OpenStarmapResource =
    new Resource<() => Promise<string[]>>('OpenStarmap');

function getPlayerJumpRoute(world: World) {
    for (const entity of world.entities.values()) {
        if (!entity.components.has(PlayerShipSelector)) {
            continue;
        }
        const jumpRoute = entity.components.get(JumpRouteComponent);
        if (jumpRoute) {
            return jumpRoute;
        }
    }
    return undefined;
}

export const StarmapPlugin: Plugin = {
    name: 'StarmapPlugin',
    build(world) {
        const simulationData = world.resources.get(SimulationGameDataResource);
        if (!simulationData) {
            throw new Error('Expected SimulationGameDataResource to exist');
        }
        const displayAssets = world.resources.get(DisplayAssetDataResource);
        if (!displayAssets) {
            throw new Error('Expected DisplayAssetDataResource to exist');
        }
        const controls = world.resources.get(ControlsSubject);
        if (!controls) {
            throw new Error('Expected ControlsSubject to exist');
        }
        const stage = world.resources.get(Stage);
        if (!stage) {
            throw new Error('Expected Stage to exist');
        }
        const systemId = world.resources.get(SystemIdResource);
        if (!systemId) {
            throw new Error('Expected SystemIdResource to exist');
        }
        const screenSize = world.resources.get(ScreenSize);
        if (!screenSize) {
            throw new Error('Expected ScreenSize to exist');
        }

        // NCB system visibility uses the player's real control bits.
        const getPlayerBits = (): ReadonlySet<number> => {
            for (const entity of world.entities.values()) {
                if (entity.components.has(PlayerShipSelector)) {
                    return entity.components.get(ControlBitsComponent)
                        ?? new Set();
                }
            }
            return new Set();
        };
        const starmap = new Starmap(displayAssets, simulationData, systemId,
            controls, getPlayerBits);
        let opening = false;
        stage.addChild(starmap.container);
        world.resources.set(StarmapResource, starmap);
        const openStarmap = async (): Promise<string[]> => {
            const jumpRoute = getPlayerJumpRoute(world);
            if (starmap.container.visible || opening) {
                return jumpRoute?.route ?? [];
            }
            opening = true;
            try {
                starmap.container.position.set(screenSize.x / 2, screenSize.y / 2);
                const route = await starmap.show(jumpRoute?.route ?? []);
                if (jumpRoute) {
                    jumpRoute.route = route;
                }
                world.emit(SetJumpRouteEvent, { route });
                return route;
            } finally {
                opening = false;
            }
        };
        world.resources.set(OpenStarmapResource, openStarmap);
        world.resources.set(StarmapControlsSubscription, controls.subscribe(({ action, state }) => {
            if (action !== 'map' || state !== 'start') {
                return;
            }
            // While a landed menu owns the keyboard, 'm' belongs to
            // that menu (the spaceport opens the map itself; deeper
            // screens reserve the key but don't act on it).
            if (MenuControls.focused) {
                return;
            }
            void openStarmap();
        }));
    },
    remove(world) {
        world.resources.get(StarmapControlsSubscription)?.unsubscribe();
        const stage = world.resources.get(Stage);
        const starmap = world.resources.get(StarmapResource);
        if (stage && starmap) {
            stage.removeChild(starmap.container);
        }
        world.resources.delete(StarmapControlsSubscription);
        world.resources.delete(StarmapResource);
        world.resources.delete(OpenStarmapResource);
    }
}
