import { isLeft } from "fp-ts/lib/Either.js";
import { Entity } from "nova_ecs/entity";
import { CommunicatorResource, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { EncodedEntity, Serializer, SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { Time, TimeResource } from "nova_ecs/plugins/time_plugin";
import { World } from "nova_ecs/world";
import { v4 } from "uuid";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { loadEntityGameData } from "../nova_plugin/entity_data_loader.js";
import { makeNpc } from "../nova_plugin/npc_plugin.js";
import { ControlEvent, ControlsSubject, EcsControlEvent } from "../nova_plugin/controls_plugin.js";
import { JumpRouteComponent } from "../nova_plugin/jump_plugin.js";
import { EncodedSimulationBridgeEvent, getRegisteredSimulationBridgeEvents } from "./simulation_bridge_events.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";


export interface EntityDelta {
    /** Present only when the entity's name changed. */
    name?: string;
    /** Components whose encoded form changed since the last snapshot. */
    changed: [string, unknown][];
    /** Names of components removed since the last snapshot. */
    removed: string[];
}

/**
 * A delta frame. Entities absent from `added`, `changed`, and `removed`
 * are unchanged since the previous snapshot from the same host.
 */
export interface SimulationFrame {
    added: [string, EncodedEntity][];
    changed: [string, EntityDelta][];
    removed: string[];
    time?: Time;
    events: EncodedSimulationBridgeEvent[];
}

export interface SimulationBridgeHostApi {
    controlEvents(events: ControlEvent[]): void;
    step(count?: number): void;
    snapshot(): SimulationFrame;
    addEntity(uuid: string, entity: EncodedEntity): void | Promise<void>;
    removeEntity(uuid: string): void;
    setPlayerJumpRoute(route: string[]): void;
    spawnNpc(shipId: string): void | Promise<void>;
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

interface SentEntityRecord {
    name: string | undefined;
    /** Component name -> JSON of the component's encoded form as last sent. */
    components: Map<string, string>;
}

export class SimulationBridgeHost implements SimulationBridgeHostApi {
    private queuedEvents: EncodedSimulationBridgeEvent[] = [];
    private lastSent = new Map<string, SentEntityRecord>();

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
        const serializer = this.serializer;

        const added: [string, EncodedEntity][] = [];
        const changed: [string, EntityDelta][] = [];
        const seen = new Set<string>();

        for (const [uuid, entity] of this.world.entities) {
            if (uuid === "singleton") {
                continue;
            }
            seen.add(uuid);
            const previous = this.lastSent.get(uuid);

            const encodedComponents: [string, unknown][] = [];
            const record: SentEntityRecord = {
                name: entity.name,
                components: new Map(),
            };
            for (const [component, data] of entity.components) {
                if (!serializer.hasComponent(component)) {
                    continue;
                }
                const encoded = serializer.encodeComponent(component, data);
                encodedComponents.push([component.name, encoded]);
                record.components.set(component.name,
                    JSON.stringify(encoded) ?? 'undefined');
            }

            if (!previous) {
                added.push([uuid, {
                    name: entity.name,
                    components: encodedComponents,
                } as EncodedEntity]);
            } else {
                const delta: EntityDelta = { changed: [], removed: [] };
                if (previous.name !== entity.name) {
                    delta.name = entity.name;
                }
                for (const [componentName, encoded] of encodedComponents) {
                    if (previous.components.get(componentName)
                        !== record.components.get(componentName)) {
                        delta.changed.push([componentName, encoded]);
                    }
                }
                for (const componentName of previous.components.keys()) {
                    if (!record.components.has(componentName)) {
                        delta.removed.push(componentName);
                    }
                }
                if (delta.name !== undefined || delta.changed.length > 0
                    || delta.removed.length > 0) {
                    changed.push([uuid, delta]);
                }
            }
            this.lastSent.set(uuid, record);
        }

        const removed: string[] = [];
        for (const uuid of this.lastSent.keys()) {
            if (!seen.has(uuid)) {
                removed.push(uuid);
                this.lastSent.delete(uuid);
            }
        }

        return {
            added,
            changed,
            removed,
            time: this.world.resources.get(TimeResource),
            events,
        };
    }

    /**
     * Forgets all previously sent state so the next snapshot resends
     * every entity in full.
     */
    resetSync() {
        this.lastSent.clear();
    }

    async addEntity(uuid: string, entity: EncodedEntity) {
        const decoded = this.serializer.decode(entity);
        if (isLeft(decoded)) {
            throw new Error(`Failed to decode entity: ${this.serializer.describeDecodeFailure(entity, decoded.left)}`);
        }
        // Stage, load, then insert: the entity only enters the
        // simulation once the transitive closure of game data it (and
        // anything it can spawn) needs is loaded, so the simulation
        // never waits for data mid-step. The insertion tick is an
        // input, so it is allowed to vary.
        await loadEntityGameData(this.world, decoded.right);
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

    async spawnNpc(shipId: string) {
        // Load through this world's own game data: the display side warming
        // its cache does not warm the worker's cache.
        const shipData = await this.simulationGameData.data.Ship.get(shipId);
        if (!shipData) {
            throw new Error(`Failed to load ship ${shipId} for NPC spawn`);
        }
        const npc = makeNpc(shipData);
        await loadEntityGameData(this.world, npc);
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
        return this.host.addEntity(uuid, structuredClone(this.serializer.encode(entity)) as EncodedEntity);
    }

    removeEntity(uuid: string) {
        this.host.removeEntity(uuid);
    }

    setPlayerJumpRoute(route: string[]) {
        this.host.setPlayerJumpRoute(structuredClone(route));
    }

    spawnNpc(shipId: string) {
        return this.host.spawnNpc(shipId);
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
