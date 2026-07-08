import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { World } from 'nova_ecs/world';
import { EcsEvent } from 'nova_ecs/events';
import { Subscription } from 'rxjs';
import { DisplayAssetDataResource, SimulationGameDataResource } from '../nova_plugin/game_data_resource.js';
import { ControlsSubject } from '../nova_plugin/controls_plugin.js';
import { JumpRouteComponent } from '../nova_plugin/jump_plugin.js';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin.js';
import { SystemIdResource } from '../nova_plugin/system_id_resource.js';
import { Starmap } from '../spaceport/starmap.js';
import { ScreenSize } from './screen_size_plugin.js';
import { Stage } from './stage_resource.js';

const StarmapResource = new Resource<Starmap>("Starmap");
const StarmapControlsSubscription = new Resource<Subscription>('StarmapControlsSubscription');
export const SetJumpRouteEvent = new EcsEvent<{ route: string[] }>('SetJumpRouteEvent');

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

        const starmap = new Starmap(displayAssets, simulationData, systemId, controls);
        let opening = false;
        stage.addChild(starmap.container);
        world.resources.set(StarmapResource, starmap);
        world.resources.set(StarmapControlsSubscription, controls.subscribe(async ({ action, state }) => {
            if (action !== 'map' || state !== 'start' || starmap.container.visible || opening) {
                return;
            }
            opening = true;
            try {
                starmap.container.position.set(screenSize.x / 2, screenSize.y / 2);
                const jumpRoute = getPlayerJumpRoute(world);
                const route = await starmap.show(jumpRoute?.route ?? []);
                if (jumpRoute) {
                    jumpRoute.route = route;
                }
                world.emit(SetJumpRouteEvent, { route });
            } finally {
                opening = false;
            }
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
    }
}
