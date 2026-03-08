import { Entity } from "nova_ecs/entity";
import { AddEvent } from "nova_ecs/events";
import { multiplayer, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { System } from "nova_ecs/system";
import { World } from "nova_ecs/world";
import * as PIXI from "pixi.js";
import { firstValueFrom, take, filter } from "rxjs";
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
import { DisplayAssetDataResource, SimulationGameDataResource } from "./nova_plugin/game_data_resource.js";
import { FinishJumpEvent } from "./nova_plugin/jump_plugin.js";
import { makeShip } from "./nova_plugin/make_ship.js";
import { makeSystem } from "./nova_plugin/make_system.js";
import { MultiRoomResource, NovaPlugin, SystemComponent } from "./nova_plugin/nova_plugin.js";
import { PlayerShipSelector } from "./nova_plugin/player_ship_plugin.js";
import { SystemIdResource } from "./nova_plugin/system_id_resource.js";


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
let system: World | undefined;

async function jumpTo({ entity, to, uuid }: { entity: Entity, to: string, uuid: string }) {
    if (system) {
        system.entities.delete(uuid);
        system.step(); // Let peers know the entity was removed
        const stage = system.resources.get(Stage);
        if (stage) {
            app.stage.removeChild(stage);
        }
        const currentSystemUuid = system.resources.get(SystemIdResource);
        if (currentSystemUuid) {
            world.entities.delete(currentSystemUuid);
            multiRoom.leave(currentSystemUuid);
        }
        await system.removePlugin(Display);
    }

    const newSystem = makeSystem(to, simulationGameData);
    (window as any).novaDebug = new DebugSettings(newSystem, (window as any).novaDebug);

    (window as any).system = newSystem;
    newSystem.resources.set(DisplayAssetDataResource, displayAssetData);
    newSystem.resources.set(PixiAppResource, app);
    await newSystem.addPlugin(Display);

    const newStage = newSystem.resources.get(Stage);
    if (!newStage) {
        throw new Error('World did not have Pixi Stage');
    }
    app.stage.addChild(newStage);
    newStage.visible = true;

    const room = multiRoom.join(to);
    await newSystem.addPlugin(multiplayer(room));

    newSystem.events.get(FinishJumpEvent).subscribe(jumpTo);

    world.entities.set(to, new Entity()
        .addComponent(SystemComponent, newSystem));

    // Wait for the server to connect
    if (!room.peers.current.value.has('server')) {
        await firstValueFrom(room.peers.join.pipe(filter(a => a === 'server')));
    }
    newSystem.entities.set(uuid, entity);
    system = newSystem;
}

async function startGame() {
    world = new World();
    world.resources.set(SimulationGameDataResource, simulationGameData);
    world.resources.set(DisplayAssetDataResource, displayAssetData);
    await world.addPlugin(multiplayer(multiRoom.join('main room')));
    world.resources.set(MultiRoomResource, multiRoom);
    await world.addPlugin(NovaPlugin);

    // Make the player's ship
    const ids = await simulationGameData.ids;
    let randomShip = ids.Ship[Math.floor(Math.random() * ids.Ship.length)];
    const shipData = await simulationGameData.data.Ship.get(randomShip);
    const shipEntity = makeShip(shipData);
    shipEntity.components.set(MultiplayerData, {
        owner: communicator.uuid!
    });
    shipEntity.components.set(PlayerShipSelector, undefined);
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
        system?.emit(ResizeEvent, { x: window.innerWidth, y: window.innerHeight });
    }
    window.onresize = resize;

    const stats = new Stats();
    document.body.appendChild(stats.dom);

    //(window as any).novaDebug = new DebugSettings(activeSystem);

    app.ticker.add(() => {
        stats.begin();
        world.step();
        //activeSystem?.step();
        stats.end();
    });
}

startGame()



