import { isLeft } from "fp-ts/lib/Either.js";
import { Entity } from "nova_ecs/entity";
import { RollbackSimulation } from "nova_ecs/plugins/rollback_plugin";
import { restoreWorld, snapshotWorld, SnapshotPolicies, SnapshotPoliciesResource, WorldSnapshot } from "nova_ecs/plugins/snapshot_plugin";
import { hashWorld } from "nova_ecs/plugins/world_hash";
import { CommunicatorResource, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { EncodedEntity, Serializer, SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { Time, TimeResource } from "nova_ecs/plugins/time_plugin";
import { World } from "nova_ecs/world";
import { v4 } from "uuid";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { loadEntityGameData } from "../nova_plugin/entity_data_loader.js";
import { deriveEntityComponents } from "../nova_plugin/entity_factory.js";
import { applyInputRecords, InputRecord, SimulationInput } from "./simulation_input.js";
import { canonicalDesyncHash, unwrapRollbackMessage, wrapRollbackMessage } from "./rollback_protocol.js";
import { makeNpc } from "../nova_plugin/npc_plugin.js";
import { PEER_LOCAL_COMPONENTS } from "../nova_plugin/ship_control.js";
import { ControlEvent, ControlsSubject, EcsControlEvent } from "../nova_plugin/controls_plugin.js";
import { EncodedSimulationBridgeEvent, getRegisteredSimulationBridgeEvents } from "./simulation_bridge_events.js";


/**
 * Peers hash their world every this many ticks (desync detection)...
 */
const STATE_HASH_INTERVAL = 60;
/**
 * ...and publish a checkpoint's hash once it is this many ticks old:
 * past any realistic rollback depth, so the hashed state is settled.
 * (Rollbacks that do cross a pending checkpoint recompute its hash
 * during resimulation.)
 */
const STATE_HASH_SETTLE_TICKS = 30;
/** Minimum time between automatic desync recoveries. */
const RESYNC_COOLDOWN_MS = 10_000;

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
    /** Debug/netcode: roll back `ticks` and resimulate. */
    rewind(ticks: number): boolean;
    /** Desync recovery: rebuild from genesis plus the room's input log. */
    resync(): Promise<boolean>;
}

export interface AsyncSimulationBridgeHostApi {
    controlEvents(events: ControlEvent[]): Promise<void>;
    step(count?: number): Promise<void>;
    snapshot(): Promise<SimulationFrame>;
    addEntity(uuid: string, entity: EncodedEntity): Promise<void>;
    removeEntity(uuid: string): Promise<void>;
    setPlayerJumpRoute(route: string[]): Promise<void>;
    spawnNpc(shipId: string): Promise<void>;
    rewind(ticks: number): Promise<boolean>;
    resync(): Promise<boolean>;
}

interface SentEntityRecord {
    name: string | undefined;
    /** Component name -> JSON of the component's encoded form as last sent. */
    components: Map<string, string>;
}

export class SimulationBridgeHost implements SimulationBridgeHostApi {
    private queuedEvents: EncodedSimulationBridgeEvent[] = [];
    private lastSent = new Map<string, SentEntityRecord>();
    private rollback: RollbackSimulation<InputRecord[]>;
    /** Inputs that apply at the next stepped tick. */
    private pendingInputs: SimulationInput[] = [];
    /**
     * Remote peers' input records, relayed by the server. Buffered
     * here until per-peer input application lands (Phase 3 step 3).
     */
    private remoteInputs: InputRecord[] = [];
    /** The server's canonical tick, from its periodic tickSync. */
    serverTick?: number;
    /**
     * The pre-join genesis state. Desync recovery restores it and
     * resimulates the relay's input log — the late-join reconstruction,
     * repurposed.
     */
    private genesis: WorldSnapshot;
    /** World hashes at checkpoint ticks, awaiting settling. */
    private checkpointHashes = new Map<number, string>();
    /** Desync notifications received (own divergence or another peer's). */
    desyncCount = 0;
    private resyncing = false;
    private lastResyncTime = -Infinity;

    constructor(
        private world: World,
        private simulationGameData: SimulationGameDataInterface,
    ) {
        // Bare test worlds may not have snapshot policies configured.
        if (!world.resources.has(SnapshotPoliciesResource)) {
            world.resources.set(SnapshotPoliciesResource, new SnapshotPolicies());
        }
        this.genesis = snapshotWorld(world);
        this.rollback = this.makeRollback();
        // Receive relayed rollback-protocol messages from the room.
        const communicator = world.resources.get(CommunicatorResource);
        communicator?.messages.subscribe(({ message }) => {
            const rollbackMessage = unwrapRollbackMessage(message);
            if (!rollbackMessage) {
                return;
            }
            switch (rollbackMessage.kind) {
                case 'inputs':
                    this.remoteInputs.push(rollbackMessage.record);
                    break;
                case 'tickSync':
                    this.serverTick = rollbackMessage.tick;
                    break;
                case 'inputLog':
                    this.remoteInputs.push(...rollbackMessage.records);
                    break;
                case 'desync':
                    this.handleDesync(rollbackMessage.tick, rollbackMessage.hashes);
                    break;
            }
        });
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

    private makeRollback(): RollbackSimulation<InputRecord[]> {
        return new RollbackSimulation<InputRecord[]>(this.world, {
            applyInputs: applyInputRecords,
            complete: deriveEntityComponents,
            // Two seconds of history: enough for netcode rollback
            // margins and short novaSim.rewind time travel.
            capacity: 120,
            // Fires on resimulated ticks too, so a rollback across a
            // pending checkpoint recomputes its hash from the
            // corrected state.
            onStep: tick => {
                if (tick > 0 && tick % STATE_HASH_INTERVAL === 0) {
                    this.checkpointHashes.set(tick,
                        hashWorld(this.world, PEER_LOCAL_COMPONENTS).hash);
                }
            },
        });
    }

    private get serializer() {
        const serializer = this.world.resources.get(SerializerResource);
        if (!serializer) {
            throw new Error("Expected serializer resource to exist");
        }
        return serializer;
    }

    /**
     * Everything that changes the simulation goes through tick-stamped
     * input records: schedule() queues an input for the next stepped
     * tick, where the rollback driver records and applies it. This is
     * the same path resimulation replays.
     */
    private schedule(input: SimulationInput) {
        this.pendingInputs.push(input);
    }

    step(count = 1) {
        if (this.resyncing) {
            // Mid-recovery the world is being rebuilt from the input
            // log; stepping it would fork a fresh timeline.
            return;
        }
        this.integrateRemoteInputs();
        for (let i = 0; i < count; i++) {
            if (this.pendingInputs.length > 0) {
                const tick = this.rollback.tick + 1;
                const communicator = this.world.resources.get(CommunicatorResource);
                const record: InputRecord = {
                    peerId: communicator?.uuid,
                    tick,
                    inputs: this.pendingInputs,
                };
                this.addRecord(tick, record);
                this.publishInputs(record);
                this.pendingInputs = [];
            }
            this.rollback.step();
        }
        this.publishStateHashes();
    }

    /**
     * Joins the room's shared timeline: requests the input log from the
     * relay and replays it over the deterministic genesis world. If no
     * relay responds (offline play), continues from tick 0.
     */
    async joinRoom(timeoutMs = 5000): Promise<boolean> {
        const communicator = this.world.resources.get(CommunicatorResource);
        if (!communicator?.uuid) {
            return false;
        }
        const catchUp = await new Promise<
            { tick: number, records: InputRecord[] } | undefined
        >(resolve => {
            const subscription = communicator.messages.subscribe(({ message }) => {
                const rollbackMessage = unwrapRollbackMessage(message);
                if (rollbackMessage?.kind === 'catchUp') {
                    clearInterval(retry);
                    clearTimeout(timeout);
                    subscription.unsubscribe();
                    // Records relayed to us before this reply were
                    // logged by the relay before it built the reply
                    // (messages are ordered), so they are already in
                    // the catch-up log: drop them or they apply twice.
                    this.remoteInputs = [];
                    resolve(rollbackMessage);
                }
            });
            const request = () => {
                const server = [...communicator.servers.value][0];
                if (server) {
                    communicator.sendMessage(
                        wrapRollbackMessage({ kind: 'joinRequest' }), server);
                }
            };
            // The relay may not exist yet when the first peer joins.
            const retry = setInterval(request, 1000);
            const timeout = setTimeout(() => {
                clearInterval(retry);
                subscription.unsubscribe();
                resolve(undefined);
            }, timeoutMs);
            request();
        });
        if (!catchUp) {
            console.warn('No rollback relay responded; starting at tick 0');
            return false;
        }
        for (const record of catchUp.records) {
            this.addRecord(record.tick, record);
        }
        this.rollback.fastForward(catchUp.tick);
        return true;
    }

    /** Merges a record into the tick's record list. */
    private addRecord(tick: number, record: InputRecord) {
        const existing = this.rollback.getInputs(tick) ?? [];
        this.rollback.setInputs(tick, [...existing, record]);
    }

    /**
     * Folds relayed remote input records into the timeline. Records
     * for past ticks trigger a rollback: restore before the earliest
     * correction and resimulate with the true inputs — the core of
     * rollback netcode.
     */
    private integrateRemoteInputs() {
        if (this.remoteInputs.length === 0) {
            return;
        }
        const records = this.remoteInputs;
        this.remoteInputs = [];
        let earliestCorrection: number | undefined;
        for (const record of records) {
            // Too old to roll back to: apply as soon as possible
            // instead of dropping the input entirely. (Desync detection
            // will catch any resulting divergence.)
            const tick = Math.max(record.tick, this.rollback.earliestTick + 1);
            this.addRecord(tick, { ...record, tick });
            if (tick <= this.rollback.tick) {
                earliestCorrection = Math.min(earliestCorrection ?? Infinity, tick);
            }
        }
        if (earliestCorrection !== undefined) {
            this.rollback.rollbackTo(earliestCorrection - 1);
        }
    }

    /**
     * Publishes this peer's inputs to the server relay only: the relay
     * is the single fan-out, so peers never receive a record twice
     * (once directly, once relayed).
     */
    private publishInputs(record: InputRecord) {
        const communicator = this.world.resources.get(CommunicatorResource);
        if (!communicator?.uuid) {
            return;
        }
        const server = [...communicator.servers.value][0];
        if (!server) {
            return;
        }
        communicator.sendMessage(wrapRollbackMessage({
            kind: 'inputs',
            record,
        }), server);
    }

    /**
     * Publishes checkpoint hashes that have settled: old enough that
     * no further rollback will cross them, so every honest peer hashed
     * the same timeline. The relay compares them across peers.
     */
    private publishStateHashes() {
        const communicator = this.world.resources.get(CommunicatorResource);
        const server = communicator?.uuid
            ? [...communicator.servers.value][0] : undefined;
        for (const [tick, hash] of this.checkpointHashes) {
            if (tick <= this.rollback.tick - STATE_HASH_SETTLE_TICKS) {
                this.checkpointHashes.delete(tick);
                if (communicator && server) {
                    communicator.sendMessage(wrapRollbackMessage(
                        { kind: 'stateHash', tick, hash }), server);
                }
            }
        }
    }

    /**
     * The relay saw peers disagree about the state at a tick. If this
     * peer's hash is not the canonical one, its timeline has diverged
     * from the input log's true simulation: recover with a full resync.
     */
    private handleDesync(tick: number, hashes: [string, string][]) {
        this.desyncCount++;
        const communicator = this.world.resources.get(CommunicatorResource);
        const mine = hashes.find(
            ([peerId]) => peerId === communicator?.uuid)?.[1];
        const canonical = canonicalDesyncHash(hashes);
        // A peer that never reported this tick (it joined afterwards)
        // has no evidence it diverged.
        const diverged = mine !== undefined && mine !== canonical;
        console.error(`Desync at tick ${tick}:`, Object.fromEntries(hashes),
            diverged ? '- this peer diverged; resyncing'
                : '- this peer matches the canonical state');
        if (diverged) {
            void this.resync();
        }
    }

    /**
     * Full desync recovery: restore the deterministic genesis world
     * and rejoin the room, resimulating the relay's input log — the
     * same reconstruction a late joiner performs.
     */
    async resync(): Promise<boolean> {
        if (this.resyncing
            || Date.now() - this.lastResyncTime < RESYNC_COOLDOWN_MS) {
            return false;
        }
        this.lastResyncTime = Date.now();
        this.resyncing = true;
        try {
            restoreWorld(this.world, this.genesis, deriveEntityComponents);
            this.rollback = this.makeRollback();
            this.remoteInputs = [];
            this.checkpointHashes.clear();
            return await this.joinRoom();
        } finally {
            this.resyncing = false;
        }
    }

    rewind(ticks: number): boolean {
        // True time travel: restore the past and continue from there,
        // discarding the abandoned future. (rollbackTo, by contrast,
        // replays the inputs back to the present - the netcode
        // primitive - which is a visual no-op.)
        const rewound = this.rollback.rewindTo(this.rollback.tick - ticks);
        if (rewound) {
            // Checkpoint hashes from the discarded future would report
            // a timeline that no longer exists.
            for (const tick of this.checkpointHashes.keys()) {
                if (tick > this.rollback.tick) {
                    this.checkpointHashes.delete(tick);
                }
            }
        }
        return rewound;
    }

    controlEvents(events: ControlEvent[]) {
        this.schedule({ kind: 'control', events });
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
        // Stage, load, then schedule: the entity's transitive game
        // data closure is loaded before the insertion input is
        // recorded, so applying (and replaying) the input is
        // synchronous.
        await loadEntityGameData(this.world, decoded.right);
        this.schedule({ kind: 'addEntity', uuid, entity });
    }

    removeEntity(uuid: string) {
        this.schedule({ kind: 'removeEntity', uuid });
    }

    setPlayerJumpRoute(route: string[]) {
        this.schedule({ kind: 'setJumpRoute', route });
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
        // The spawn becomes an insertion input: staged host-side, then
        // scheduled, so replaying it is deterministic.
        this.schedule({
            kind: 'addEntity',
            uuid: v4(),
            entity: structuredClone(this.serializer.encode(npc)) as EncodedEntity,
        });
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

    rewind(ticks: number) {
        return this.host.rewind(ticks);
    }

    resync() {
        return this.host.resync();
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

    async rewind(ticks: number) {
        return this.host.rewind(ticks);
    }

    async resync() {
        return this.host.resync();
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
