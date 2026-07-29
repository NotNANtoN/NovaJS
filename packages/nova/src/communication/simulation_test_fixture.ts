import fs from "fs";
import path from "path";
import { v4 } from "uuid";
import { multiplayer, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { MockCommunicator } from "nova_ecs/plugins/mock_communicator";
import { GameDataAggregator } from "../server/parsing/game_data_aggregator.js";
import { FilesystemData } from "../server/parsing/filesystem_data.js";
import { NovaParse } from "novaparse";
import { completeEntity } from "../nova_plugin/entity_data_loader.js";
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
        // Base "Nova Files" data ONLY (novaPlugins: null). Tests must not
        // depend on which plug-ins happen to be installed in the developer's
        // Nova_Data/Plug-ins directory — otherwise ids, ship/system/outfit
        // stats and even sorted-first ids change from machine to machine.
        // The dev server (server.ts / nova_parse_worker.ts) still loads
        // plug-ins as usual; only tests opt out.
        const novaParse = new NovaParse(path.join(packageRoot, "Nova_Data"), false,
            { novaFiles: "Nova Files", novaPlugins: null });
        novaParse.resourceNotFoundFunction = () => { };
        const aggregator = new GameDataAggregator([
            new FilesystemData(path.join(packageRoot, "objects")),
            novaParse,
        ], () => { });
        // The browser fetches settings over HTTP; in node, read them
        // from disk so worlds can build with the 'worker' platform
        // (which includes the control systems).
        (aggregator as { getSettings?(file: string): Promise<unknown> }).getSettings =
            async (file: string) => JSON.parse(await fs.promises.readFile(
                path.join(packageRoot, 'settings', file), 'utf8'));
        gameDataPromise = Promise.resolve(aggregator);
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

    // No NPC traffic: this harness is a controlled battlefield. With
    // base data only, the sorted-first ids are the stock sÿst nova:1124
    // (Procyon, AvgShips 1) and shïp nova:128 (the Shuttle); ambient
    // spawns would still make the battlefield nondeterministic to
    // reason about, so they stay off.
    const world = await makeSystem(systemId, gameData, undefined,
        { npcs: false });
    const communicator = new MockCommunicator("server");
    await world.addPlugin(multiplayer(communicator));

    const shipData = await gameData.data.Ship.get(shipId);
    const ship = makeShip(shipData);
    const shipUuid = v4();
    ship.components.set(MultiplayerData, { owner: "server" });
    ship.components.set(PlayerShipSelector, undefined);
    await completeEntity(world, ship);
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
