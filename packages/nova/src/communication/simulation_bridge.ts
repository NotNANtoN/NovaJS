import { isLeft } from "fp-ts/lib/Either.js";
import { Entity } from "nova_ecs/entity";
import { CommunicatorResource, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { EncodedEntity, Serializer, SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { Time, TimeResource } from "nova_ecs/plugins/time_plugin";
import { World } from "nova_ecs/world";
import { v4 } from "uuid";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { makeNpc } from "../nova_plugin/npc_plugin.js";
import { EncodedSimulationBridgeEvent, getRegisteredSimulationBridgeEvents } from "./simulation_bridge_events.js";

export type SimulationBridgeCommand =
    | { type: "step", count?: number }
    | { type: "snapshot" }
    | { type: "addEntity", uuid: string, entity: EncodedEntity }
    | { type: "removeEntity", uuid: string }
    | { type: "spawnNpc", shipId: string };

export interface SimulationFrame {
    entities: [string, EncodedEntity][];
    time?: Time;
    events: EncodedSimulationBridgeEvent[];
}

export type SimulationBridgeResponse =
    | { type: "snapshotResult", frame: SimulationFrame }
    | { type: "ok" };

export type SimulationBridgeRequestMessage = {
    id: number,
    command: SimulationBridgeCommand,
};

export type SimulationBridgeResponseMessage =
    | { id: number, ok: true, response: SimulationBridgeResponse }
    | { id: number, ok: false, error: string };

export type MessageHandler<Message> = (message: Message) => void;

export interface BridgeEndpoint<Send, Receive> {
    setHandler(handler: MessageHandler<Receive>): void;
    send(message: Send): void;
    close?(): void | Promise<void>;
}

class LocalBridgeEndpoint<Send, Receive> implements BridgeEndpoint<Send, Receive> {
    private handler?: MessageHandler<Receive>;
    peer?: LocalBridgeEndpoint<Receive, Send>;

    setHandler(handler: MessageHandler<Receive>) {
        this.handler = handler;
    }

    send(message: Send) {
        const cloned = structuredClone(message) as Send;
        this.peer?.handler?.(cloned as never);
    }
}

export function makeSimulationBridgeEndpoints() {
    const browser = new LocalBridgeEndpoint<SimulationBridgeRequestMessage, SimulationBridgeResponseMessage>();
    const simulation = new LocalBridgeEndpoint<SimulationBridgeResponseMessage, SimulationBridgeRequestMessage>();
    browser.peer = simulation;
    simulation.peer = browser;
    return { browser, simulation };
}

function makeSnapshot(world: World, serializer: Serializer, events: EncodedSimulationBridgeEvent[]): SimulationFrame {
    return {
        entities: [...world.entities]
            .filter(([uuid]) => uuid !== "singleton")
            .map(([uuid, entity]) => [uuid, serializer.encode(entity)]),
        time: world.resources.get(TimeResource),
        events,
    };
}

export class SimulationBridgeHost {
    private queuedEvents: EncodedSimulationBridgeEvent[] = [];

    constructor(
        private endpoint: BridgeEndpoint<SimulationBridgeResponseMessage, SimulationBridgeRequestMessage>,
        private world: World,
        private simulationGameData: SimulationGameDataInterface,
    ) {
        endpoint.setHandler(this.onRequest);
        for (const registration of getRegisteredSimulationBridgeEvents()) {
            world.events.get(registration.event).subscribe(({ data, entities }) => {
                const entityUuids = registration.includeEntityUuids
                    ? entities?.map(entity => typeof entity === "string" ? entity : entity.uuid)
                    : undefined;
                this.queuedEvents.push({
                    name: registration.name,
                    data: this.serializer.encodeEvent(registration.event, data),
                    ...(entityUuids ? { entityUuids } : {}),
                });
            });
        }
    }

    private get serializer() {
        const serializer = this.world.resources.get(SerializerResource);
        if (!serializer) {
            throw new Error("Expected serializer resource to exist");
        }
        return serializer;
    }

    private onRequest = (message: SimulationBridgeRequestMessage) => {
        try {
            const response = this.handle(message.command);
            this.endpoint.send({
                id: message.id,
                ok: true,
                response,
            });
        } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            this.endpoint.send({
                id: message.id,
                ok: false,
                error: messageText,
            });
        }
    };

    private handle(command: SimulationBridgeCommand): SimulationBridgeResponse {
        switch (command.type) {
            case "step": {
                const count = command.count ?? 1;
                for (let i = 0; i < count; i++) {
                    this.world.step();
                }
                return { type: "ok" };
            }
            case "snapshot": {
                const events = this.queuedEvents;
                this.queuedEvents = [];
                return {
                    type: "snapshotResult",
                    frame: makeSnapshot(this.world, this.serializer, events),
                };
            }
            case "addEntity": {
                const decoded = this.serializer.decode(command.entity);
                if (isLeft(decoded)) {
                    throw new Error(`Failed to decode entity: ${this.serializer.describeDecodeFailure(command.entity, decoded.left)}`);
                }
                this.world.entities.set(command.uuid, decoded.right);
                return { type: "ok" };
            }
            case "removeEntity": {
                this.world.entities.delete(command.uuid);
                return { type: "ok" };
            }
            case "spawnNpc": {
                const shipData = this.simulationGameData.data.Ship.getCached(command.shipId);
                if (!shipData) {
                    throw new Error(`Expected ship ${command.shipId} to be cached before spawning NPC`);
                }
                const npc = makeNpc(shipData);
                const communicator = this.world.resources.get(CommunicatorResource);
                if (!communicator?.uuid) {
                    throw new Error("Expected communicator uuid to exist before spawning NPC");
                }
                npc.components.set(MultiplayerData, { owner: communicator.uuid });
                this.world.entities.set(v4(), npc);
                return { type: "ok" };
            }
        }
    }
}

export class SimulationBridgeClient {
    private nextId = 1;
    private responses = new Map<number, SimulationBridgeResponseMessage>();

    constructor(
        private endpoint: BridgeEndpoint<SimulationBridgeRequestMessage, SimulationBridgeResponseMessage>,
        private serializer: Serializer,
    ) {
        endpoint.setHandler(message => {
            this.responses.set(message.id, message);
        });
    }

    send(command: SimulationBridgeCommand): SimulationBridgeResponse {
        const id = this.nextId++;
        this.endpoint.send({ id, command });
        const response = this.responses.get(id);
        if (!response) {
            throw new Error(`Missing bridge response for ${command.type}`);
        }
        this.responses.delete(id);
        if (!response.ok) {
            throw new Error(response.error);
        }
        return response.response;
    }

    snapshot(): SimulationFrame {
        const response = this.send({ type: "snapshot" });
        if (response.type !== "snapshotResult") {
            throw new Error(`Expected snapshotResult, got ${response.type}`);
        }
        return response.frame;
    }

    step(count = 1) {
        this.send({ type: "step", count });
    }

    addEntity(uuid: string, entity: Entity) {
        this.send({
            type: "addEntity",
            uuid,
            entity: this.serializer.encode(entity),
        });
    }

    removeEntity(uuid: string) {
        this.send({ type: "removeEntity", uuid });
    }

    spawnNpc(shipId: string) {
        this.send({ type: "spawnNpc", shipId });
    }

    getSerializer() {
        return this.serializer;
    }

    decodeEntity(entity: EncodedEntity) {
        const decoded = this.serializer.decode(entity);
        if (isLeft(decoded)) {
            throw new Error(`Failed to decode entity: ${this.serializer.describeDecodeFailure(entity, decoded.left)}`);
        }
        return decoded.right;
    }
}

export class AsyncSimulationBridgeClient {
    private nextId = 1;
    private responses = new Map<number, {
        resolve: (response: SimulationBridgeResponse) => void,
        reject: (error: Error) => void,
    }>();

    constructor(
        private endpoint: BridgeEndpoint<SimulationBridgeRequestMessage, SimulationBridgeResponseMessage>,
        private serializer: Serializer,
    ) {
        endpoint.setHandler(message => {
            const pending = this.responses.get(message.id);
            if (!pending) {
                return;
            }
            this.responses.delete(message.id);
            if (!message.ok) {
                pending.reject(new Error(message.error));
                return;
            }
            pending.resolve(message.response);
        });
    }

    send(command: SimulationBridgeCommand): Promise<SimulationBridgeResponse> {
        const id = this.nextId++;
        const response = new Promise<SimulationBridgeResponse>((resolve, reject) => {
            this.responses.set(id, { resolve, reject });
        });
        this.endpoint.send({ id, command });
        return response;
    }

    async snapshot(): Promise<SimulationFrame> {
        const response = await this.send({ type: "snapshot" });
        if (response.type !== "snapshotResult") {
            throw new Error(`Expected snapshotResult, got ${response.type}`);
        }
        return response.frame;
    }

    async step(count = 1) {
        await this.send({ type: "step", count });
    }

    async addEntity(uuid: string, entity: Entity) {
        await this.send({
            type: "addEntity",
            uuid,
            entity: this.serializer.encode(entity),
        });
    }

    async removeEntity(uuid: string) {
        await this.send({ type: "removeEntity", uuid });
    }

    async spawnNpc(shipId: string) {
        await this.send({ type: "spawnNpc", shipId });
    }

    getSerializer() {
        return this.serializer;
    }

    decodeEntity(entity: EncodedEntity) {
        const decoded = this.serializer.decode(entity);
        if (isLeft(decoded)) {
            throw new Error(`Failed to decode entity: ${this.serializer.describeDecodeFailure(entity, decoded.left)}`);
        }
        return decoded.right;
    }

    async close() {
        await this.endpoint.close?.();
    }
}
