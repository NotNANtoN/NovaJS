import { Entities, UUID } from 'nova_ecs/arg_types';
import { AsyncSystem } from 'nova_ecs/async_system';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { GameData } from '../client/gamedata/GameData';
import { ControlsSubject, EcsControlEvent } from '../nova_plugin/controls_plugin';
import { GameDataResource } from '../nova_plugin/game_data_resource';
import { JumpRouteComponent } from '../nova_plugin/jump_plugin';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import { PlayerStateComponent } from '../nova_plugin/player_state';
import { Optional } from 'nova_ecs/optional';
import { SystemIdResource } from '../nova_plugin/system_id_resource';
import { Starmap, StarmapPlayerMarker } from '../spaceport/starmap';
import { ChatHistoryResource } from './chat_feed_plugin';
import { ScreenSize } from './screen_size_plugin';
import { Stage } from './stage_resource';
import {
    handleMapControlEvent,
    isMapStartEdge,
    MapPlayerState,
} from './starmap_control';

export { handleMapControlEvent, isMapStartEdge } from './starmap_control';

export const StarmapResource = new Resource<Starmap>("Starmap");

export const MapSystem = new AsyncSystem({
    name: 'MapSystem',
    events: [EcsControlEvent] as const,
    exclusive: true,
    alwaysRunOnEvents: false,
    skipIfApplyingPatches: true,
    args: [EcsControlEvent, StarmapResource, JumpRouteComponent,
        ScreenSize, Entities, UUID, PlayerShipSelector,
        Optional(PlayerStateComponent), Optional(ChatHistoryResource)] as const,
    async step(controlEvent, starmap, jumpRoute, screenSize, entities, uuid,
        playerState, chatHistory) {
        if (!isMapStartEdge(controlEvent, starmap.container.visible)) {
            return;
        }
        const playerMarkers: StarmapPlayerMarker[] = [];
        if (chatHistory) {
            for (const [, entries] of chatHistory) {
                const latest = entries[entries.length - 1];
                if (latest?.system) {
                    playerMarkers.push({
                        name: latest.fromName || 'Captain',
                        systemId: latest.system,
                        kind: latest.kind ?? 'normal',
                    });
                }
            }
        }
        return handleMapControlEvent(
            controlEvent, starmap, jumpRoute, screenSize,
            playerState as MapPlayerState | undefined,
            // Resolved after the map closes, because the component read on the
            // way in belongs to a step that has long since ended.
            route => {
                const live = entities.get(uuid)
                    ?.components.get(JumpRouteComponent);
                if (live) {
                    live.route = route;
                }
            },
            playerMarkers,
        );
    }
});

export const StarmapPlugin: Plugin = {
    name: 'StarmapPlugin',
    build(world) {
        const gameData = world.resources.get(GameDataResource);
        if (!gameData) {
            throw new Error('Expected GameDataResource to exist');
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

        const starmap = new Starmap(gameData as GameData, systemId, controls);
        starmap.attachTo(stage);
        world.resources.set(StarmapResource, starmap);

        world.addSystem(MapSystem);
    },
    remove(world) {
        world.removeSystem(MapSystem);
        const starmap = world.resources.get(StarmapResource);
        if (starmap) {
            starmap.dispose();
        }
        world.resources.delete(StarmapResource);
    }
}
