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
import { DockedShip, DockedShipResource } from './docked_ship.js';
import { OpenMissionInfoResource } from './mission_info_plugin.js';
import { OpenPlayerInfoResource } from './player_info_plugin.js';
import { ResizeEvent, ScreenSize } from './screen_size_plugin.js';
import { Stage } from './stage_resource.js';
import { OpenStarmapResource } from './starmap_plugin.js';


const SpaceportComponent = new Component<Spaceport>("Spaceport");

const SpaceportProvider = Provide({
    name: "SpaceportProvider",
    provided: SpaceportComponent,
    args: [DisplayAssetDataResource, SimulationGameDataResource, ControlsSubject, Stage, OpenStarmapResource, OpenPlayerInfoResource, OpenMissionInfoResource, PlanetComponent] as const,
    factory(displayAssets, simulationData, controls, stage, openStarmap, openPlayerInfo, openMissionInfo, { id }) {
        const spaceport = new Spaceport(displayAssets, simulationData, id, controls, openStarmap, openPlayerInfo, openMissionInfo);
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
    args: [OpenSpaceportEvent, RunQuery, ScreenSize, Emit,
        DockedShipResource, SingletonComponent] as const,
    step({ planetId, ship }, runQuery, { x, y }, emit, dockedHolder) {
        const spaceport = runQuery(SpaceportQuery)
            .find(([, { id }]) => id === planetId)?.[0];
        if (!spaceport) {
            return;
        }

        // Publish the held ship so the status bar (out-of-world while docked)
        // keeps drawing its credits/fuel/cargo, and let the spaceport push
        // each venue's live working state through it per-transaction.
        const dockedShip = new DockedShip(ship);
        dockedHolder.current = dockedShip;
        spaceport.setDockedShip(dockedShip);

        spaceport.container.position.x = x / 2;
        spaceport.container.position.y = y / 2;
        spaceport.show(ship).then(newShip => emit(LeaveSpaceportEvent, newShip));
    }
});

const CloseSpaceportSystem = new System({
    name: 'CloseSpaceportSystem',
    events: [LeaveSpaceportEvent],
    args: [DockedShipResource, SingletonComponent] as const,
    step(dockedHolder) {
        // Back in flight: the in-world PlayerShipSelector systems take over.
        dockedHolder.current = undefined;
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
        // Created here if the status bar plugin hasn't already; both
        // set-if-absent so build order is moot.
        if (!world.resources.get(DockedShipResource)) {
            world.resources.set(DockedShipResource, {});
        }
        world.addSystem(SpaceportProvider);
        world.addSystem(OpenSpaceportSystem);
        world.addSystem(CloseSpaceportSystem);
        world.addSystem(SpaceportResizeSystem);
    },
    remove(world) {
        world.removeSystem(SpaceportProvider);
        world.removeSystem(OpenSpaceportSystem);
        world.removeSystem(CloseSpaceportSystem);
        world.removeSystem(SpaceportResizeSystem);
    }
}
