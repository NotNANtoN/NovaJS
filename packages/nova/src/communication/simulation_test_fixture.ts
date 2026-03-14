import path from "path";
import { v4 } from "uuid";
import { multiplayer, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { MockCommunicator } from "nova_ecs/plugins/mock_communicator";
import { GameDataAggregator } from "../server/parsing/game_data_aggregator.js";
import { FilesystemData } from "../server/parsing/filesystem_data.js";
import { NovaParse } from "novaparse";
import { makeShip } from "../nova_plugin/make_ship.js";
import { makeSystem } from "../nova_plugin/make_system.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";
import {
    SimulationBridgeClient,
    SimulationBridgeHost,
} from "./simulation_bridge.js";
import { SerializerResource } from "nova_ecs/plugins/serializer_plugin";

const packageRoot = process.cwd();

let gameDataPromise: Promise<GameDataAggregator> | undefined;

export async function getIntegrationGameData() {
    if (!gameDataPromise) {
        const novaParse = new NovaParse(path.join(packageRoot, "Nova_Data"), false);
        novaParse.resourceNotFoundFunction = () => { };
        gameDataPromise = Promise.resolve(new GameDataAggregator([
            new FilesystemData(path.join(packageRoot, "objects")),
            novaParse,
        ], () => { }));
    }
    return gameDataPromise;
}

export async function makeSimulationBridgeHarness() {
    const gameData = await getIntegrationGameData();
    const ids = await gameData.ids;
    const systemId = [...ids.System].sort()[0];
    const shipId = [...ids.Ship].sort()[0];

    if (!systemId) {
        throw new Error("Expected at least one system id");
    }
    if (!shipId) {
        throw new Error("Expected at least one ship id");
    }

    const world = await makeSystem(systemId, gameData);
    const communicator = new MockCommunicator("server");
    await world.addPlugin(multiplayer(communicator));

    const shipData = await gameData.data.Ship.get(shipId);
    const ship = makeShip(shipData);
    const shipUuid = v4();
    ship.components.set(MultiplayerData, { owner: "server" });
    ship.components.set(PlayerShipSelector, undefined);
    world.entities.set(shipUuid, ship);

    for (let i = 0; i < 10; i++) {
        world.step();
    }

    const serializer = world.resources.get(SerializerResource);
    if (!serializer) {
        throw new Error("Expected simulation serializer resource");
    }

    const host = new SimulationBridgeHost(world, gameData);
    const client = new SimulationBridgeClient(host, serializer);

    return {
        client,
        gameData,
        shipId,
        shipUuid,
        systemId,
        world,
    };
}
