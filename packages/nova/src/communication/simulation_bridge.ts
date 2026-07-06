import { isLeft } from "fp-ts/lib/Either.js";
import { Entity } from "nova_ecs/entity";
import { CommunicatorResource, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { EncodedEntity, Serializer, SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { Time, TimeResource } from "nova_ecs/plugins/time_plugin";
import { World } from "nova_ecs/world";
import { v4 } from "uuid";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { makeNpc } from "../nova_plugin/npc_plugin.js";
import { ControlEvent, ControlsSubject, EcsControlEvent } from "../nova_plugin/controls_plugin.js";
import { JumpRouteComponent } from "../nova_plugin/jump_plugin.js";
import { EncodedSimulationBridgeEvent, getRegisteredSimulationBridgeEvents } from "./simulation_bridge_events.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";


export interface SimulationFrame {
    entities: [string, EncodedEntity][];
    time?: Time;
    events: EncodedSimulationBridgeEvent[];
}

export interface SimulationBridgeHostApi {
    controlEvents(events: ControlEvent[]): void;
    step(count?: number): void;
    snapshot(): SimulationFrame;
    addEntity(uuid: string, entity: EncodedEntity): void;
    removeEntity(uuid: string): void;
    setPlayerJumpRoute(route: string[]): void;
    spawnNpc(shipId: string): void;
}

export interface AsyncSimulationBridgeHostApi {
    controlEvents(events: ControlEvent[]): Promise<void>;
    step(count?: number): Promise<void>;
    snapshot(): Promise<SimulationFrame>;
    addEntity(uuid: string, entity: EncodedEntity): Promise<void>;
    removeEntity(uuid: string): Promise<void>;
    setPlayerJumpRoute(route: string[]): Promise<void>;
    spawnNpc(shipId: string): Promise<void>;
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

export class SimulationBridgeHost implements SimulationBridgeHostApi {
    private queuedEvents: EncodedSimulationBridgeEvent[] = [];

    constructor(
        private world: World,
        private simulationGameData: SimulationGameDataInterface,
    ) {
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

    step(count = 1) {
        for (let i = 0; i < count; i++) {
            this.world.step();
        }
    }

    controlEvents(events: ControlEvent[]) {
        this.world.emit(EcsControlEvent, events);
        const controlsSubject = this.world.resources.get(ControlsSubject);
        if (controlsSubject) {
            for (const event of events) {
                controlsSubject.next(event);
            }
        }
    }

    snapshot(): SimulationFrame {
        const events = this.queuedEvents;
        this.queuedEvents = [];
        return makeSnapshot(this.world, this.serializer, events);
    }

    addEntity(uuid: string, entity: EncodedEntity) {
        const decoded = this.serializer.decode(entity);
        if (isLeft(decoded)) {
            throw new Error(`Failed to decode entity: ${this.serializer.describeDecodeFailure(entity, decoded.left)}`);
        }
        this.world.entities.set(uuid, decoded.right);
    }

    removeEntity(uuid: string) {
        this.world.entities.delete(uuid);
    }

    setPlayerJumpRoute(route: string[]) {
        for (const entity of this.world.entities.values()) {
            if (!entity.components.has(PlayerShipSelector)) {
                continue;
            }
            const jumpRoute = entity.components.get(JumpRouteComponent);
            if (!jumpRoute) {
                continue;
            }
            jumpRoute.route = [...route];
            return;
        }
        throw new Error("Expected player ship jump route to exist");
    }

    spawnNpc(shipId: string) {
        const shipData = this.simulationGameData.data.Ship.getCached(shipId);
        if (!shipData) {
            throw new Error(`Expected ship ${shipId} to be cached before spawning NPC`);
        }
        const npc = makeNpc(shipData);
        const communicator = this.world.resources.get(CommunicatorResource);
        if (!communicator?.uuid) {
            throw new Error("Expected communicator uuid to exist before spawning NPC");
        }
        npc.components.set(MultiplayerData, { owner: communicator.uuid });
        this.world.entities.set(v4(), npc);
    }
}

export class SimulationBridgeClient {
    constructor(
        private host: SimulationBridgeHostApi,
        private serializer: Serializer,
    ) { }

    snapshot(): SimulationFrame {
        return structuredClone(this.host.snapshot()) as SimulationFrame;
    }

    step(count = 1) {
        this.host.step(count);
    }

    controlEvents(events: ControlEvent[]) {
        this.host.controlEvents(structuredClone(events));
    }

    addEntity(uuid: string, entity: Entity) {
        this.host.addEntity(uuid, structuredClone(this.serializer.encode(entity)) as EncodedEntity);
    }

    removeEntity(uuid: string) {
        this.host.removeEntity(uuid);
    }

    setPlayerJumpRoute(route: string[]) {
        this.host.setPlayerJumpRoute(structuredClone(route));
    }

    spawnNpc(shipId: string) {
        this.host.spawnNpc(shipId);
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
    constructor(
        private host: AsyncSimulationBridgeHostApi,
        private serializer: Serializer,
        private closeImpl?: () => void | Promise<void>,
    ) { }

    async snapshot(): Promise<SimulationFrame> {
        return await this.host.snapshot();
    }

    async step(count = 1) {
        await this.host.step(count);
    }

    async controlEvents(events: ControlEvent[]) {
        await this.host.controlEvents(events);
    }

    async addEntity(uuid: string, entity: Entity) {
        await this.host.addEntity(uuid, this.serializer.encode(entity));
    }

    async removeEntity(uuid: string) {
        await this.host.removeEntity(uuid);
    }

    async setPlayerJumpRoute(route: string[]) {
        await this.host.setPlayerJumpRoute(route);
    }

    async spawnNpc(shipId: string) {
        await this.host.spawnNpc(shipId);
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
        await this.closeImpl?.();
    }
}
