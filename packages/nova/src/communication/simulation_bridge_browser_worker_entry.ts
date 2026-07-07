import * as Comlink from "comlink";
import { BehaviorSubject, Subject } from "rxjs";
import { Communicator, CommunicatorResource, Peers } from "nova_ecs/plugins/multiplayer_plugin";
import { SimulationGameData } from "../client/gamedata/simulation_game_data.js";
import { ControlEvent } from "../nova_plugin/controls_plugin.js";
import { makeSystem } from "../nova_plugin/make_system.js";
import { SimulationBridgeHost, SimulationFrame } from "./simulation_bridge.js";
import { BrowserSimulationBridgeWorkerApi, BrowserWorkerRoomState } from "./simulation_bridge_browser_worker.js";
import { EncodedEntity } from "nova_ecs/plugins/serializer_plugin";


class WorkerRoomCommunicator implements Communicator {
    readonly messages = new Subject<{ source: string, message: unknown }>();
    readonly peers = new Peers(new BehaviorSubject(new Set<string>()));
    readonly servers = new BehaviorSubject(new Set<string>(['server']));
    readonly connected = new BehaviorSubject(false);
    uuid: string | undefined;

    constructor(
        private sendToRoom: (message: unknown, destination?: string | Set<string>) => void | Promise<void>,
        initialState: BrowserWorkerRoomState,
    ) {
        this.updateRoomState(initialState);
    }

    updateRoomState(state: BrowserWorkerRoomState) {
        if ('uuid' in state) {
            this.uuid = state.uuid;
        }
        if (state.peers) {
            this.peers.current.next(new Set(state.peers));
        }
        if (typeof state.connected === 'boolean') {
            this.connected.next(state.connected);
        }
        if (state.servers) {
            this.servers.next(new Set(state.servers));
        }
    }

    receiveMessage(source: string, message: unknown) {
        this.messages.next({ source, message });
    }

    sendMessage(message: unknown, destination?: string | Set<string>) {
        void this.sendToRoom(message, destination);
    }
}

class BrowserSimulationBridgeHost implements BrowserSimulationBridgeWorkerApi {
    private bridge?: SimulationBridgeHost;
    private world?: Awaited<ReturnType<typeof makeSystem>>;
    private communicator?: WorkerRoomCommunicator;

    async init(args: {
        systemId: string;
        roomState: BrowserWorkerRoomState;
    },
        sendMessage: (message: unknown, destination?: string | Set<string>) => void | Promise<void>,
    ) {
        const simulationGameData = new SimulationGameData();
        const world = await makeSystem(args.systemId, simulationGameData, 'worker');
        const communicator = new WorkerRoomCommunicator(sendMessage, args.roomState);
        // Pure input-driven multiplayer: no delta-sync plugin. The world
        // evolves only from the deterministic genesis plus the room's
        // tick-stamped input records.
        world.resources.set(CommunicatorResource, communicator);

        this.world = world;
        this.communicator = communicator;
        this.bridge = new SimulationBridgeHost(world, simulationGameData);
        // Join the room's shared timeline by replaying its input log.
        await this.bridge.joinRoom();
    }

    async updateRoomState(state: BrowserWorkerRoomState) {
        this.requireCommunicator().updateRoomState(state);
    }

    async receiveRoomMessage(source: string, message: unknown) {
        this.requireCommunicator().receiveMessage(source, message);
    }

    async controlEvents(events: ControlEvent[]) {
        this.requireBridge().controlEvents(events);
    }

    async step(count?: number) {
        this.requireBridge().step(count);
    }

    async snapshot(): Promise<SimulationFrame> {
        return this.requireBridge().snapshot();
    }

    async addEntity(uuid: string, entity: EncodedEntity) {
        await this.requireBridge().addEntity(uuid, entity);
    }

    async removeEntity(uuid: string) {
        this.requireBridge().removeEntity(uuid);
    }

    async setPlayerJumpRoute(route: string[]) {
        this.requireBridge().setPlayerJumpRoute(route);
    }

    async spawnNpc(shipId: string) {
        await this.requireBridge().spawnNpc(shipId);
    }

    async rewind(ticks: number) {
        return this.requireBridge().rewind(ticks);
    }

    async resync() {
        return this.requireBridge().resync();
    }

    private requireBridge() {
        if (!this.bridge) {
            throw new Error("Simulation worker has not been initialized");
        }
        return this.bridge;
    }

    private requireWorld() {
        if (!this.world) {
            throw new Error("Simulation worker has not been initialized");
        }
        return this.world;
    }

    private requireCommunicator() {
        if (!this.communicator) {
            throw new Error("Simulation worker has not been initialized");
        }
        return this.communicator;
    }
}

Comlink.expose(new BrowserSimulationBridgeHost());
