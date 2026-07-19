import { Emit } from 'nova_ecs/arg_types';
import { Entity } from 'nova_ecs/entity';
import { EcsEvent } from 'nova_ecs/events';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { ControlsSubject } from '../nova_plugin/controls_plugin.js';
import { DisplayAssetDataResource, SimulationGameDataResource } from '../nova_plugin/game_data_resource.js';
import { GateMap } from '../spaceport/gate_map.js';
import { ResizeEvent, ScreenSize } from './screen_size_plugin.js';
import { Stage } from './stage_resource.js';

/**
 * The hypergate map UI (display-side, player-local — like the spaceport).
 * The browser docks the ship on a hypergate landing (removing it from the
 * sim through the same machinery as a spaceport dock) and emits
 * OpenGateMapEvent; the map resolves with the picked neighbor gate (or null
 * for "lift back off") via LeaveGateMapEvent, which the browser turns into a
 * jumpTo room switch or a relaunch.
 */
export const OpenGateMapEvent = new EcsEvent<{
    gateSpob: string,
    systemId: string,
    ship: Entity,
}>('OpenGateMapEvent');

export const LeaveGateMapEvent = new EcsEvent<{
    ship: Entity,
    destinationSpob: string | null,
}>('LeaveGateMapEvent');

const GateMapResource = new Resource<GateMap>('GateMapResource');

const OpenGateMapSystem = new System({
    name: 'OpenGateMapSystem',
    events: [OpenGateMapEvent],
    args: [OpenGateMapEvent, GateMapResource, ScreenSize, Emit,
        SingletonComponent] as const,
    step({ gateSpob, systemId, ship }, gateMap, { x, y }, emit) {
        gateMap.container.position.x = x / 2;
        gateMap.container.position.y = y / 2;
        void gateMap.show({ gateSpob, systemId, destinationSpob: null })
            .then(({ destinationSpob }) =>
                emit(LeaveGateMapEvent, { ship, destinationSpob }));
    }
});

const GateMapResizeSystem = new System({
    name: 'GateMapResize',
    events: [ResizeEvent],
    args: [ResizeEvent, GateMapResource, SingletonComponent] as const,
    step({ x, y }, gateMap) {
        gateMap.container.position.x = x / 2;
        gateMap.container.position.y = y / 2;
    }
});

export const GateMapPlugin: Plugin = {
    name: 'GateMapPlugin',
    build(world) {
        const displayAssets = world.resources.get(DisplayAssetDataResource);
        const simulationData = world.resources.get(SimulationGameDataResource);
        const controls = world.resources.get(ControlsSubject);
        const stage = world.resources.get(Stage);
        if (!displayAssets || !simulationData || !controls || !stage) {
            throw new Error('Expected display assets, game data, controls, '
                + 'and stage resources for the gate map');
        }
        const gateMap = new GateMap(displayAssets, simulationData, controls);
        stage.addChild(gateMap.container);
        world.resources.set(GateMapResource, gateMap);
        world.addSystem(OpenGateMapSystem);
        world.addSystem(GateMapResizeSystem);
    },
    remove(world) {
        const gateMap = world.resources.get(GateMapResource);
        const stage = world.resources.get(Stage);
        if (gateMap) {
            stage?.removeChild(gateMap.container);
        }
        world.removeSystem(OpenGateMapSystem);
        world.removeSystem(GateMapResizeSystem);
        world.resources.delete(GateMapResource);
    }
}
