import { Emit, RunQuery } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { Plugin } from 'nova_ecs/plugin';
import { Provide } from 'nova_ecs/provide';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { EcsEvent } from 'nova_ecs/events';
import { SingletonComponent } from 'nova_ecs/world';
import { ControlsSubject } from '../nova_plugin/controls_plugin.js';
import { DisplayAssetDataResource, SimulationGameDataResource } from '../nova_plugin/game_data_resource.js';
import { PlanetComponent } from '../nova_plugin/planet_plugin.js';
import { Spaceport } from '../spaceport/spaceport.js';
import { ResizeEvent, ScreenSize } from './screen_size_plugin.js';
import { Stage } from './stage_resource.js';


const SpaceportComponent = new Component<Spaceport>("Spaceport");

const SpaceportProvider = Provide({
    name: "SpaceportProvider",
    provided: SpaceportComponent,
    args: [DisplayAssetDataResource, SimulationGameDataResource, ControlsSubject, Stage, PlanetComponent] as const,
    factory(displayAssets, simulationData, controls, stage, { id }) {
        const spaceport = new Spaceport(displayAssets, simulationData, id, controls);
        stage.addChild(spaceport.container);
        return spaceport;
    }
});

const SpaceportQuery = new Query([SpaceportComponent, PlanetComponent] as const);

export const OpenSpaceportEvent = new EcsEvent<{ planetId: string, ship: Entity }>('OpenSpaceportEvent');
export const LeaveSpaceportEvent = new EcsEvent<Entity>('LeaveSpaceportEvent');

const OpenSpaceportSystem = new System({
    name: 'OpenSpaceportSystem',
    events: [OpenSpaceportEvent],
    args: [OpenSpaceportEvent, RunQuery, ScreenSize, Emit, SingletonComponent] as const,
    step({ planetId, ship }, runQuery, { x, y }, emit) {
        const spaceport = runQuery(SpaceportQuery)
            .find(([, { id }]) => id === planetId)?.[0];
        if (!spaceport) {
            return;
        }

        spaceport.container.position.x = x / 2;
        spaceport.container.position.y = y / 2;
        spaceport.show(ship).then(newShip => emit(LeaveSpaceportEvent, newShip));
    }
});

const SpaceportResizeSystem = new System({
    name: 'SpaceportResize',
    events: [ResizeEvent],
    args: [ResizeEvent, SpaceportComponent] as const,
    step({ x, y }, spaceport) {
        spaceport.container.position.x = x / 2;
        spaceport.container.position.y = y / 2;
    }
});

export const SpaceportPlugin: Plugin = {
    name: 'SpaceportPlugin',
    build(world) {
        world.addSystem(SpaceportProvider);
        world.addSystem(OpenSpaceportSystem);
        world.addSystem(SpaceportResizeSystem);
    },
    remove(world) {
        world.removeSystem(SpaceportProvider);
        world.removeSystem(OpenSpaceportSystem);
        world.removeSystem(SpaceportResizeSystem);
    }
}
