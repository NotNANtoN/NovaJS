import { Worker } from "worker_threads";
import { Serializer } from "nova_ecs/plugins/serializer_plugin";
import {
    AsyncSimulationBridgeClient,
    BridgeEndpoint,
    MessageHandler,
    SimulationBridgeRequestMessage,
    SimulationBridgeResponseMessage,
} from "./simulation_bridge.js";


type NodeMessagePortLike<Send, Receive> = {
    on(event: "message", listener: (message: Receive) => void): unknown;
    off?(event: "message", listener: (message: Receive) => void): unknown;
    postMessage(message: Send): void;
    close?(): void;
    terminate?(): Promise<number>;
};

export class NodeMessageEndpoint<Send, Receive> implements BridgeEndpoint<Send, Receive> {
    private handler?: MessageHandler<Receive>;

    constructor(private port: NodeMessagePortLike<Send, Receive>) {
        port.on("message", this.onMessage);
    }

    private onMessage = (message: Receive) => {
        this.handler?.(message);
    };

    setHandler(handler: MessageHandler<Receive>) {
        this.handler = handler;
    }

    send(message: Send) {
        this.port.postMessage(message);
    }

    async close() {
        this.port.off?.("message", this.onMessage);
        if (this.port.terminate) {
            await this.port.terminate();
            return;
        }
        this.port.close?.();
    }
}

export function makeWorkerThreadSimulationBridgeClient(worker: Worker, serializer: Serializer) {
    return new AsyncSimulationBridgeClient(
        new NodeMessageEndpoint<SimulationBridgeRequestMessage, SimulationBridgeResponseMessage>(
            worker as NodeMessagePortLike<SimulationBridgeRequestMessage, SimulationBridgeResponseMessage>,
        ),
        serializer,
    );
}
