import { isLeft } from "fp-ts/lib/Either.js";
import { UnknownComponent } from "nova_ecs/component";
import { Entity } from "nova_ecs/entity";
import { EcsEvent } from "nova_ecs/events";
import { AddEvent } from "nova_ecs/events";
import { multiplayer, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { CommunicatorResource } from "nova_ecs/plugins/multiplayer_plugin";
import { SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { System } from "nova_ecs/system";
import { World } from "nova_ecs/world";
import * as PIXI from "pixi.js";
import { firstValueFrom, filter } from "rxjs";
import Stats from 'stats.js';
import { v4 } from "uuid";
import { DisplayAssetData } from "./client/gamedata/display_asset_data.js";
import { SimulationGameData } from "./client/gamedata/simulation_game_data.js";
import { CommunicatorClient } from "./communication/communicator_client.js";
import { MultiRoom } from "./communication/multi_room_communicator.js";
import { SocketChannelClient } from "./communication/socket_channel_client.js";
import { DebugSettings } from "./debug_settings.js";
import { Display } from "./display/display_plugin.js";
import { PixiAppResource } from "./display/pixi_app_resource.js";
import { ResizeEvent } from "./display/screen_size_plugin.js";
import { Stage } from "./display/stage_resource.js";
import { ControlStateEvent } from "./nova_plugin/control_state_event.js";
import { ControlsSubject, EcsControlEvent } from "./nova_plugin/controls_plugin.js";
import { DisplayAssetDataResource, SimulationGameDataResource } from "./nova_plugin/game_data_resource.js";
import { DeathEvent, ZeroArmorEvent } from "./nova_plugin/death_plugin.js";
import { FinishJumpEvent } from "./nova_plugin/jump_plugin.js";
import { makeShip } from "./nova_plugin/make_ship.js";
import { makeSystem } from "./nova_plugin/make_system.js";
import { LandEvent } from "./nova_plugin/planet_plugin.js";
import { ProjectileCollisionEvent, ProjectileExplodeEvent } from "./nova_plugin/projectile_plugin.js";
import { MultiRoomResource, NovaPlugin, SystemComponent } from "./nova_plugin/nova_plugin.js";
import { PlayerShipSelector } from "./nova_plugin/player_ship_plugin.js";
import { SoundEvent } from "./nova_plugin/sound_event.js";
import { SystemIdResource } from "./nova_plugin/system_id_resource.js";
import { ChangeSecondaryEvent } from "./nova_plugin/weapon_plugin.js";


const simulationGameData = new SimulationGameData();
const displayAssetData = new DisplayAssetData();
(window as any).simulationGameData = simulationGameData;
(window as any).displayAssetData = displayAssetData;
(window as any).PIXI = PIXI;

const pixelRatio = window.devicePixelRatio || 1;
PIXI.settings.RESOLUTION = pixelRatio;
PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.LINEAR;

// TODO: Using WebGL 1 (instead of 2) seems to make the game smoother, but
// this will likely change in the future.
//PIXI.settings.PREFER_ENV = PIXI.ENV.WEBGL2;
const app = new PIXI.Application({
    width: window.innerWidth,
    height: window.innerHeight,
    autoDensity: true
});

(window as any).app = app;
document.body.appendChild(app.view as any);

const channel = new SocketChannelClient({});
const communicator = new CommunicatorClient(channel);
(window as any).communicator = communicator;
const multiRoom = new MultiRoom(communicator);
(window as any).multiRoom = multiRoom;

let world: World;
let simulationWorld: World | undefined;
let displayWorld: World | undefined;
const syncedComponents = new Map<string, Set<UnknownComponent>>();
const warnedUnsyncableEntities = new Set<string>();

function bridgeEvent<Data>(simulationWorld: World, displayWorld: World, event: EcsEvent<Data>) {
    simulationWorld.events.get(event).subscribe(data => {
        displayWorld.emit(event, data);
    });
}

function syncEntityToDisplay(uuid: string, simulationEntity: Entity, simulationWorld: World, displayWorld: World) {
    const serializer = simulationWorld.resources.get(SerializerResource);
    if (!serializer) {
        throw new Error('Expected simulation serializer resource to exist');
    }
    const encodedEntity = serializer.encode(simulationEntity);
    const decoded = serializer.decode(encodedEntity);
    if (isLeft(decoded)) {
        if (!warnedUnsyncableEntities.has(uuid)) {
            warnedUnsyncableEntities.add(uuid);
            console.warn(
                `Skipping entity ${uuid} because serializer decode failed: `
                + serializer.describeDecodeFailure(encodedEntity, decoded.left)
            );
        }
        return;
    }
    const syncedEntity = decoded.right;

    let displayEntity = displayWorld.entities.get(uuid);
    if (!displayEntity) {
        displayEntity = new Entity(syncedEntity.name);
        displayWorld.entities.set(uuid, displayEntity);
    } else if (displayEntity.name !== syncedEntity.name) {
        displayEntity.name = syncedEntity.name;
    }

    const previousComponents = syncedComponents.get(uuid) ?? new Set<UnknownComponent>();
    const nextComponents = new Set<UnknownComponent>(syncedEntity.components.keys());

    for (const [component, data] of syncedEntity.components) {
        displayEntity.components.set(component, data);
    }

    for (const component of previousComponents) {
        if (!nextComponents.has(component)) {
            displayEntity.components.delete(component);
        }
    }

    syncedComponents.set(uuid, nextComponents);
}

function syncSimulationToDisplay(simulationWorld: World, displayWorld: World) {
    const nextUuids = new Set<string>();
    for (const [uuid, entity] of simulationWorld.entities) {
        if (uuid === 'singleton') {
            continue;
        }
        nextUuids.add(uuid);
        syncEntityToDisplay(uuid, entity, simulationWorld, displayWorld);
    }

    for (const uuid of [...syncedComponents.keys()]) {
        if (nextUuids.has(uuid)) {
            continue;
        }
        syncedComponents.delete(uuid);
        displayWorld.entities.delete(uuid);
    }

    const time = simulationWorld.resources.get(TimeResource);
    if (time) {
        displayWorld.resources.set(TimeResource, time);
    }
}

async function makeDisplayWorld(systemId: string, simulationWorld: World) {
    const displayWorld = new World(`${systemId} display`);
    displayWorld.resources.set(SimulationGameDataResource, simulationGameData);
    displayWorld.resources.set(DisplayAssetDataResource, displayAssetData);
    displayWorld.resources.set(PixiAppResource, app);
    displayWorld.resources.set(SystemIdResource, simulationWorld.resources.get(SystemIdResource)!);
    const time = simulationWorld.resources.get(TimeResource);
    if (time) {
        displayWorld.resources.set(TimeResource, time);
    }
    displayWorld.resources.set(ControlsSubject, simulationWorld.resources.get(ControlsSubject)!);
    const communicator = simulationWorld.resources.get(CommunicatorResource);
    if (communicator) {
        displayWorld.resources.set(CommunicatorResource, communicator);
    }
    await displayWorld.addPlugin(Display);

    bridgeEvent(simulationWorld, displayWorld, ChangeSecondaryEvent);
    bridgeEvent(simulationWorld, displayWorld, ControlStateEvent);
    bridgeEvent(simulationWorld, displayWorld, EcsControlEvent);
    bridgeEvent(simulationWorld, displayWorld, DeathEvent);
    bridgeEvent(simulationWorld, displayWorld, LandEvent);
    bridgeEvent(simulationWorld, displayWorld, ProjectileCollisionEvent);
    bridgeEvent(simulationWorld, displayWorld, ProjectileExplodeEvent);
    bridgeEvent(simulationWorld, displayWorld, SoundEvent);
    bridgeEvent(simulationWorld, displayWorld, ZeroArmorEvent);
    return displayWorld;
}

async function jumpTo({ entity, to, uuid }: { entity: Entity, to: string, uuid: string }) {
    if (simulationWorld) {
        simulationWorld.entities.delete(uuid);
        simulationWorld.step(); // Let peers know the entity was removed
        const stage = displayWorld?.resources.get(Stage);
        if (stage) {
            app.stage.removeChild(stage);
        }
        const currentSystemUuid = simulationWorld.resources.get(SystemIdResource);
        if (currentSystemUuid) {
            world.entities.delete(currentSystemUuid);
            multiRoom.leave(currentSystemUuid);
        }
        if (displayWorld) {
            await displayWorld.removePlugin(Display);
        }
        for (const uuid of syncedComponents.keys()) {
            displayWorld?.entities.delete(uuid);
        }
        syncedComponents.clear();
    }

    const newSimulationWorld = await makeSystem(to, simulationGameData);
    (window as any).novaDebug = new DebugSettings(newSimulationWorld, (window as any).novaDebug);

    const room = multiRoom.join(to);
    await newSimulationWorld.addPlugin(multiplayer(room));

    const newDisplayWorld = await makeDisplayWorld(to, newSimulationWorld);
    (window as any).simulationWorld = newSimulationWorld;
    (window as any).displayWorld = newDisplayWorld;

    const newStage = newDisplayWorld.resources.get(Stage);
    if (!newStage) {
        throw new Error('World did not have Pixi Stage');
    }
    app.stage.addChild(newStage);
    newStage.visible = true;

    newSimulationWorld.events.get(FinishJumpEvent).subscribe(jumpTo);

    world.entities.set(to, new Entity()
        .addComponent(SystemComponent, newSimulationWorld));

    // Wait until the current peer set includes the server, without racing
    // between an immediate state check and a later join event subscription.
    await firstValueFrom(room.peers.current.pipe(filter(peers => peers.has('server'))));
    newSimulationWorld.entities.set(uuid, entity);
    if (entity.components.has(PlayerShipSelector)) {
        (window as any).myShip = entity;
    }
    syncSimulationToDisplay(newSimulationWorld, newDisplayWorld);
    simulationWorld = newSimulationWorld;
    displayWorld = newDisplayWorld;
}

async function startGame() {
    world = new World();
    world.resources.set(SimulationGameDataResource, simulationGameData);
    await world.addPlugin(multiplayer(multiRoom.join('main room')));
    world.resources.set(MultiRoomResource, multiRoom);
    await world.addPlugin(NovaPlugin);

    // Make the player's ship
    while (!communicator.uuid) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const ids = await simulationGameData.ids;
    let randomShip = ids.Ship[Math.floor(Math.random() * ids.Ship.length)];
    const shipData = await simulationGameData.data.Ship.get(randomShip);
    const shipEntity = makeShip(shipData);
    shipEntity.components.set(MultiplayerData, {
        owner: communicator.uuid
    });
    shipEntity.components.set(PlayerShipSelector, undefined);
    (window as any).myShip = shipEntity;
    const systemId = 'nova:130';

    await jumpTo({
        entity: shipEntity,
        to: systemId,
        uuid: v4(),
    });

    // if (activeSystem) {
    //     await activeSystem.addPlugin(Display);

    //     const systemStage = activeSystem.resources.get(Stage);
    //     if (!systemStage) {
    //         throw new Error('World did not have Pixi Container');
    //     }
    //     app.stage.addChild(systemStage);
    //     systemStage.visible = true;
    // }

    // system.events.get(FinishJumpEvent).subscribe(
    // ({ entity, to, uuid }) => {

    //     const destination = systems.get(to) ?? system;
    //     destination.entities.set(uuid, entity);
    // });



    // Set active system when the player ship is added    
    // for (const [systemId, system] of systems) {
    //     system.events.get(AddEvent).subscribe(([, entity]) => {
    //         //console.log('hi');
    //         if (entity.components.has(PlayerShipSelector) &&
    //             system !== activeSystem) {
    //             console.log(`Player ship is in ${systemId}`);
    //             const systemStage = activeSystem?.resources.get(Stage);
    //             if (systemStage) {
    //                 app.stage.removeChild(systemStage);
    //             }

    //             activeSystem?.removePlugin(Display);
    //             activeSystem = system;
    //             activeSystem.addPlugin(Display);

    //             const newSystemStage = activeSystem?.resources.get(Stage);

    //             if (!newSystemStage) {
    //                 throw new Error('World did not have Pixi Container');
    //             }
    //             app.stage.addChild(newSystemStage);
    //         }
    //     });
    // }
    // console.log('Got past for loop');

    (window as any).world = world;

    function resize() {
        app.renderer.resize(window.innerWidth, window.innerHeight);
        displayWorld?.emit(ResizeEvent, { x: window.innerWidth, y: window.innerHeight });
    }
    window.onresize = resize;

    const stats = new Stats();
    document.body.appendChild(stats.dom);

    //(window as any).novaDebug = new DebugSettings(activeSystem);

    app.ticker.add(() => {
        stats.begin();
        world.step();
        if (simulationWorld && displayWorld) {
            syncSimulationToDisplay(simulationWorld, displayWorld);
        }
        displayWorld?.step();
        stats.end();
    });
}

startGame()
