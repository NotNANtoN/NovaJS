import { Emit, RunQuery } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { Plugin } from 'nova_ecs/plugin';
import { Provide } from 'nova_ecs/provide';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { EcsEvent } from 'nova_ecs/events';
import { SingletonComponent } from 'nova_ecs/world';
import { ControlsSubject } from '../nova_plugin/controls_plugin.js';
import { DisplayAssetDataResource, SimulationGameDataResource } from '../nova_plugin/game_data_resource.js';
import { PlanetComponent, PlanetDataComponent } from '../nova_plugin/planet_plugin.js';
import { Spaceport } from '../spaceport/spaceport.js';
import { OpenMissionInfoResource } from './mission_info_plugin.js';
import { OpenPlayerInfoResource } from './player_info_plugin.js';
import { ResizeEvent, ScreenSize } from './screen_size_plugin.js';
import { Stage } from './stage_resource.js';
import { OpenStarmapResource } from './starmap_plugin.js';
import { UiSoundEvent } from './ui_sound.js';


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

// Every dockable stellar with its parsed PlanetData; the ambient system
// picks the one whose spaceport is currently on its main screen.
const SpaceportAmbientQuery =
    new Query([SpaceportComponent, PlanetDataComponent] as const);
// The ambient snd currently looping (or last looped), so it can be stopped
// when the player enters a venue or launches. null = nothing playing.
const SpaceportAmbientState =
    new Resource<{ currentId: string | null }>('SpaceportAmbientState');

/**
 * Loops the landed stellar's ambient sound (spöb CustSndID -> PlanetData.
 * spaceportSound) while the player is on the spaceport MAIN screen, and
 * stops it inside any venue (outfitter/shipyard/trade/bar/BBS) or overlay
 * and on launch. Client-local per-player: it plays on the UiSoundEvent
 * channel, gated purely by this client's own on-screen state. Ambient
 * sounds are looped per the Bible ("ambient sound to play"); @pixi/sound
 * stop() resets playback, so re-entering the main screen restarts the loop
 * rather than resuming mid-sample.
 */
const SpaceportAmbientSystem = new System({
    name: 'SpaceportAmbientSound',
    args: [SpaceportAmbientState, RunQuery, DisplayAssetDataResource, Emit,
        SingletonComponent] as const,
    step(state, runQuery, displayAssets, emit) {
        const active = runQuery(SpaceportAmbientQuery)
            .find(([spaceport]) => spaceport.onMainScreen);
        const desiredId = active ? active[1].spaceportSound : null;

        if (state.currentId && state.currentId !== desiredId) {
            emit(UiSoundEvent, { id: state.currentId, stop: true });
            state.currentId = null;
        }
        if (desiredId) {
            if (state.currentId !== desiredId) {
                // Newly desired: warm the asset so the loop isn't silent
                // while it streams in (playSound reads getCached).
                displayAssets.data.Sound.get(desiredId);
            }
            emit(UiSoundEvent, { id: desiredId, loop: true });
            state.currentId = desiredId;
        }
    }
});

export const SpaceportPlugin: Plugin = {
    name: 'SpaceportPlugin',
    build(world) {
        world.resources.set(SpaceportAmbientState, { currentId: null });
        world.addSystem(SpaceportProvider);
        world.addSystem(OpenSpaceportSystem);
        world.addSystem(SpaceportResizeSystem);
        world.addSystem(SpaceportAmbientSystem);
    },
    remove(world) {
        world.removeSystem(SpaceportProvider);
        world.removeSystem(OpenSpaceportSystem);
        world.removeSystem(SpaceportResizeSystem);
        world.removeSystem(SpaceportAmbientSystem);
        world.resources.delete(SpaceportAmbientState);
    }
}
