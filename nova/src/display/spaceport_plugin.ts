import {
    Emit,
    Entities,
    GetEntity,
    GetWorld,
    RunQuery,
    UUID,
} from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { CommunicatorResource, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { Provide } from 'nova_ecs/provide';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { GameData } from '../client/gamedata/GameData';
import { ControlsSubject } from '../nova_plugin/controls_plugin';
import { GameDataResource } from '../nova_plugin/game_data_resource';
import { NcbRuntimeResource } from '../nova_plugin/ncb_runtime';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import {
    LandEvent,
    LandingResultEvent,
    PlanetComponent,
} from '../nova_plugin/planet_plugin';
import {
    MissionNotice,
    MissionRuntime,
    MissionRuntimeResource,
} from '../nova_plugin/mission_plugin';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import { PlayerStoreResource } from '../nova_plugin/player_state';
import {
    advanceGameDate,
    PlayerState,
    PlayerStateComponent,
    isStellarDestroyed,
} from '../nova_plugin/player_state';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { PlanetDataComponent } from '../nova_plugin/planet_plugin';
import { Spaceport } from '../spaceport/spaceport';
import { deImmerify } from '../util/deimmerify';
import { ResizeEvent, ScreenSize } from './screen_size_plugin';
import { persistDeparture } from './spaceport_departure';
import { Stage } from './stage_resource';


const SpaceportComponent = new Component<Spaceport>("Spaceport");

const SpaceportProvider = Provide({
    name: "SpaceportProvider",
    provided: SpaceportComponent,
    args: [GameDataResource, ControlsSubject, Stage, PlanetComponent] as const,
    factory(gameData, controls, stage, planet) {
        const spaceport = new Spaceport(
            gameData as GameData, planet, controls);
        stage.addChild(spaceport.container);
        return spaceport;
    }
});

const SpaceportQuery = new Query([SpaceportComponent] as const);

const LandSystem = new System({
    name: 'LandSystem',
    events: [LandEvent],
    args: [LandEvent, UUID, Entities, RunQuery, ScreenSize, GetEntity,
        Emit, SerializerResource,
        Optional(CommunicatorResource), PlayerShipSelector,
        Optional(MultiplayerData), GetWorld,
        Optional(PlayerStateComponent), Optional(MissionRuntimeResource),
        NcbRuntimeResource] as const,
    step({ id, uuid }, shipUuid, entities, runQuery, { x, y }, playerShip,
        emit, serializer, communicator, _playerShipSelector, playerMultiplayer,
        world, playerStateRaw, missionRuntimeRaw, ncbRuntime) {
        const playerStore = world.resources.get(PlayerStoreResource);
        const playerState = playerStateRaw;
        const missionRuntime = missionRuntimeRaw;
        const spaceport = runQuery(SpaceportQuery, uuid)[0]?.[0];
        const landedPlanet = entities.get(uuid)?.components.get(
            PlanetDataComponent);
        if (!spaceport) {
            emit(LandingResultEvent, {
                outcome: 'rejected',
                reason: 'spaceport-unavailable',
                planetName: landedPlanet?.name,
            });
            return;
        }

        if (playerState && isStellarDestroyed(playerState, id)) {
            console.warn(`Cannot land at destroyed stellar ${id}`);
            emit(LandingResultEvent, {
                outcome: 'rejected',
                reason: 'destroyed',
                planetName: landedPlanet?.name,
            });
            return;
        }
        if (playerState) {
            advanceGameDate(playerState);
            playerState.lastLandedPlanet = id;
            playerState.landingCount = (playerState.landingCount ?? 0) + 1;
            playerState.lastLandedSystem = playerState.currentSystem;
            playerState.lastLandedPosition = landedPlanet?.position ?? [0, 0];
        }
        entities.delete(shipUuid);
        deImmerify(playerShip);

        spaceport.container.position.x = x / 2;
        spaceport.container.position.y = y / 2;
        const landingState = playerShip.components.get(PlayerStateComponent);
        const outfits = playerShip.components.get(OutfitsStateComponent);
        const landingNotices = landingState && missionRuntime
            ? missionRuntime.processLanding(
                landingState, id, ncbRuntime.setContext(playerShip, landingState))
            : Promise.resolve([]);
        void landingNotices.then((notices: MissionNotice[]) => {
            if (playerState && playerStore && playerMultiplayer
                && communicator) {
                const store = playerStore;
                const token = store.getTokenForPeer(playerMultiplayer.owner);
                if (token) {
                    const ship = serializer.encode(playerShip);
                    void store.snapshot(token, playerState, ship)
                        .catch(error => console.error(
                            'Landing snapshot failed', error));
                }
            }
            if (outfits) {
                // NCB outfit handlers mutate the existing map so all
                // operations in one expression see one another. Re-setting
                // the component invalidates the outfit-derived providers.
                playerShip.components.set(OutfitsStateComponent, outfits);
            }
            return spaceport.show(playerShip, notices);
        })
            .then((newShip: Entity) => {
            if (communicator?.uuid) {
                newShip.components.set(MultiplayerData, {
                    owner: communicator.uuid,
                });
            }
            entities.set(shipUuid, newShip);
            if (playerStore && playerMultiplayer) {
                void persistDeparture(
                    playerStore,
                    playerStore.getTokenForPeer(playerMultiplayer.owner),
                    newShip,
                    playerState,
                    entity => serializer.encode(entity));
            }
            })
            .catch((error: unknown) =>
                console.error('Mission landing processing failed', error));
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
        world.addSystem(LandSystem);
        world.addSystem(SpaceportResizeSystem);
    },
    remove(world) {
        world.removeSystem(SpaceportProvider);
        world.removeSystem(LandSystem);
        world.removeSystem(SpaceportResizeSystem);
    }
}
