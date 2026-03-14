import { multiplayer } from "nova_ecs/plugins/multiplayer_plugin";
import { MockCommunicator } from "nova_ecs/plugins/mock_communicator";
import { parentPort, workerData } from "worker_threads";
import { makeSystem } from "../nova_plugin/make_system.js";
import { NodeMessageEndpoint } from "./simulation_bridge_worker_threads.js";
import { SimulationBridgeHost, SimulationBridgeRequestMessage, SimulationBridgeResponseMessage } from "./simulation_bridge.js";
import { getIntegrationGameData } from "./simulation_test_fixture.js";


export interface SimulationBridgeWorkerData {
    systemId: string;
    communicatorId?: string;
}

async function main() {
    if (!parentPort) {
        throw new Error("Missing parent port");
    }

    const { systemId, communicatorId = "server" } = workerData as SimulationBridgeWorkerData;
    const gameData = await getIntegrationGameData();
    const world = await makeSystem(systemId, gameData);
    await world.addPlugin(multiplayer(new MockCommunicator(communicatorId)));

    new SimulationBridgeHost(
        new NodeMessageEndpoint<SimulationBridgeResponseMessage, SimulationBridgeRequestMessage>(parentPort),
        world,
        gameData,
    );
}

await main();
