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
import { StatusBarResource } from './status_bar';
import { combatShopTransaction } from '../nova_plugin/combat_resources';


export const SpaceportComponent = new Component<Spaceport>("Spaceport");

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

export interface LandingSessionActions {
    authorize(): Promise<void>;
    land(): Promise<Entity>;
    recover(): Promise<Entity>;
    restore(ship: Entity): void;
    abort(): void;
    failed(error: unknown, retry: () => Promise<void>): void;
}

/** A failed/ambiguous landing remains detached until the server fences old
 * requests and confirms flight. Recovery failure always exposes a retry UI. */
export async function runLandingSession(actions: LandingSessionActions): Promise<void> {
    let recovering = false;
    const retry = async () => {
        if (recovering) return;
        recovering = true;
        try { actions.restore(await actions.recover()); }
        catch (error) { actions.failed(error, retry); }
        finally { recovering = false; }
    };
    try {
        await actions.authorize();
        actions.restore(await actions.land());
    } catch (error) {
        console.error('Landing interrupted; reconciling with server', error);
        actions.abort();
        await retry();
    }
}

function landingRecoveryDialog(error: unknown, retry: () => Promise<void>): HTMLElement {
    const panel = document.createElement('div');
    panel.setAttribute('role', 'alertdialog');
    Object.assign(panel.style, { position: 'fixed', inset: '30% 15% auto', padding: '24px',
        background: '#111', color: '#fff', zIndex: '10000', border: '1px solid #888' });
    const message = document.createElement('p');
    message.textContent = `Landing recovery is waiting for the server. Your ship will not resume flight until recovery is confirmed. ${error instanceof Error ? error.message : ''}`;
    const retryButton = document.createElement('button');
    retryButton.textContent = 'Retry recovery';
    retryButton.onclick = () => {
        retryButton.disabled = true;
        void retry().finally(() => { retryButton.disabled = false; });
    };
    const reloadButton = document.createElement('button');
    reloadButton.textContent = 'Reload / return to menu';
    reloadButton.onclick = () => window.location.reload();
    panel.append(message, retryButton, reloadButton);
    document.body.append(panel);
    retryButton.focus();
    return panel;
}

export const LandSystem = new System({
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
        deImmerify(playerShip);
        const landingState = playerShip.components.get(PlayerStateComponent);
        const landingPosition: [number, number] = landedPlanet
            ? [landedPlanet.position[0], landedPlanet.position[1]] : [0, 0];
        const owner = playerMultiplayer?.owner;
        entities.delete(shipUuid);
        const statusBar = world.resources.get(StatusBarResource);
        if (statusBar) {
            spaceport.onUpdateShip = (ship: Entity) => statusBar.updateShip(ship);
            statusBar.updateShip(playerShip);
        }
        spaceport.container.position.x = x / 2;
        spaceport.container.position.y = y / 2;
        let recoveryDialog: HTMLElement | undefined;

        void runLandingSession({
            authorize: () => spaceport.authorizeLanding(playerShip),
            land: async () => {
                if (landingState) {
                    landingState.lastLandedPlanet = id;
                    landingState.landingCount = (landingState.landingCount ?? 0) + 1;
                    landingState.lastLandedSystem = landingState.currentSystem;
                    landingState.lastLandedPosition = landingPosition;
                }
                const outfits = playerShip.components.get(OutfitsStateComponent);
                // Mission/date side effects occur only after authorization.
                const notices = landingState && missionRuntime
                    ? await missionRuntime.processLanding(
                        landingState, id, ncbRuntime.setContext(playerShip, landingState)) : [];
                if (landingState) advanceGameDate(landingState);
                if (landingState && playerStore && owner && communicator) {
                    const token = playerStore.getTokenForPeer(owner);
                    if (token) void playerStore.snapshot(token, landingState, serializer.encode(playerShip))
                        .catch(error => console.error('Landing snapshot failed', error));
                }
                if (outfits) playerShip.components.set(OutfitsStateComponent, outfits);
                return spaceport.show(playerShip, notices, true);
            },
            recover: async () => {
                if (landingState) {
                    const receipt = await combatShopTransaction(landingState, id, 'recover');
                    if (receipt.landed !== null) throw new Error('Server has not confirmed flight recovery');
                    const outfits = playerShip.components.get(OutfitsStateComponent);
                    for (const [ammo, count] of Object.entries(receipt.balance.ammo)) {
                        if (count === 0) outfits?.delete(ammo);
                        else outfits?.set(ammo, { count });
                    }
                }
                return playerShip;
            },
            restore: newShip => {
                recoveryDialog?.remove();
                if (communicator?.uuid) newShip.components.set(MultiplayerData, { owner: communicator.uuid });
                world.entities.set(shipUuid, newShip);
                if (playerStore && owner) void persistDeparture(
                    playerStore, playerStore.getTokenForPeer(owner), newShip, landingState,
                    entity => serializer.encode(entity));
            },
            abort: () => spaceport.cancelLandingPresentation(),
            failed: (error, retry) => {
                recoveryDialog?.remove();
                recoveryDialog = landingRecoveryDialog(error, retry);
            },
        });
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
