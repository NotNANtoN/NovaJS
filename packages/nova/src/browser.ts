import * as Comlink from "comlink";
import { isLeft } from "fp-ts/lib/Either.js";
import { UnknownComponent } from "nova_ecs/component";
import { Entity } from "nova_ecs/entity";
import { multiplayer } from "nova_ecs/plugins/multiplayer_plugin";
import { CommunicatorResource } from "nova_ecs/plugins/multiplayer_plugin";
import { MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { Serializer, SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { TimePlugin, TimeResource } from "nova_ecs/plugins/time_plugin";
import { World } from "nova_ecs/world";
import * as PIXI from "pixi.js";
import { firstValueFrom, filter, Subject, Subscription } from "rxjs";
import Stats from 'stats.js';
import { v4 } from "uuid";
import { DisplayAssetData } from "./client/gamedata/display_asset_data.js";
import { SimulationGameData } from "./client/gamedata/simulation_game_data.js";
import { CommunicatorClient } from "./communication/communicator_client.js";
import { MultiRoom } from "./communication/multi_room_communicator.js";
import { makeBrowserSimulationBridgeClient } from "./communication/simulation_bridge_browser_worker.js";
import { emitSimulationBridgeEvent } from "./communication/simulation_bridge_events.js";
import {
    AsyncSimulationBridgeClient,
    EntityDelta,
    SimulationBridgeClosedError,
    SimulationFrame,
    SimulationPacing,
} from "./communication/simulation_bridge.js";
import { SocketChannelClient } from "./communication/socket_channel_client.js";
import { DebugSettings } from "./debug_settings.js";
import { Display } from "./display/display_plugin.js";
import { SimulationTimeResource } from "./display/simulation_time.js";
import { PixiAppResource } from "./display/pixi_app_resource.js";
import { ResizeEvent } from "./display/screen_size_plugin.js";
import { SetJumpRouteEvent } from "./display/starmap_plugin.js";
import { LeaveSpaceportEvent, OpenSpaceportEvent } from "./display/spaceport_plugin.js";
import { Stage } from "./display/stage_resource.js";
import { AddEnemyEvent } from "./display/status_bar.js";
import { daysPerJump } from "./nova_plugin/calendar.js";
import { ControlEvent, ControlsSubject, EcsControlEvent } from "./nova_plugin/controls_plugin.js";
import { Controls, getActions, SavedControls } from "./nova_plugin/controls.js";
import { DisplayAssetDataResource, SimulationGameDataResource } from "./nova_plugin/game_data_resource.js";
import { FinishJumpEvent, JumpComponent, JumpRouteComponent } from "./nova_plugin/jump_plugin.js";
import { GateArrivalComponent, GateTransitEvent } from "./nova_plugin/gate_transit_plugin.js";
import { GateDestinationResolver } from "./nova_plugin/gate_destination_resolver.js";
import { LeaveGateMapEvent, OpenGateMapEvent } from "./display/gate_map_plugin.js";
import { GateArrivalAnticipationEvent } from "./display/gate_animation_plugin.js";
import { makeShip } from "./nova_plugin/make_ship.js";
import { makeSystem, SIMULATION_STEP_MS } from "./nova_plugin/make_system.js";
import { makeControlBitHooks, NCBParseError, runNCBSet } from "./nova_plugin/ncb.js";
import { ControlBitsComponent } from "./nova_plugin/ncb_plugin.js";
import { MultiRoomResource, NovaPlugin } from "./nova_plugin/nova_plugin.js";
import { OutfitsStateComponent } from "./nova_plugin/outfit_plugin.js";
import { LandEvent } from "./nova_plugin/planet_plugin.js";
import { PlayerShipSelector } from "./nova_plugin/player_ship_plugin.js";
import { CreditsComponent, GameDateComponent } from "./nova_plugin/player_state_plugin.js";
import { initialRecordsFromGovtStatuses } from "./nova_plugin/reputation.js";
import { CombatRatingComponent, LegalRecordsComponent } from "./nova_plugin/reputation_plugin.js";
import { extractSaveData, loadSave, resetSave, restorePlayerState, writeSave } from "./nova_plugin/save_game.js";
import { ControlledByComponent } from "./nova_plugin/ship_control.js";
import { ShipComponent, ShipPhysicsComponent } from "./nova_plugin/ship_plugin.js";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { Vector } from "nova_ecs/datatypes/vector";
import { EscortCommandComponent } from "./nova_plugin/escort_command.js";
import { FiringGroupComponent } from "./nova_plugin/firing_group.js";
import { FormationComponent, formationSlotPosition } from "./nova_plugin/npc_ai_plugin.js";
import { makeNpcShip } from "./nova_plugin/npc_spawn_plugin.js";
import { buildMissionShipSpawns } from "./nova_plugin/mission_ship_spawn.js";
import { advanceEntityDate, ensurePlayerStateComponents } from "./spaceport/mission_session.js";
import { PendingEscortsComponent } from "./spaceport/pending_escorts.js";
import { MissionUniverse } from "./spaceport/mission_universe.js";
import { SystemIdResource } from "./nova_plugin/system_id_resource.js";
import { AnalogControlState } from "./nova_plugin/ship_control.js";
import { Autopilot, ControlSinks } from "./autopilot.js";
import { installTapTargeting } from "./tap_targeting.js";
import { installTouchControls, wantsTouchControls } from "./touch_controls.js";


const simulationGameData = new SimulationGameData();
const gateDestinationResolver = new GateDestinationResolver(simulationGameData);
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
let displayWorld: World | undefined;
let simulationBridge: AsyncSimulationBridgeClient | undefined;
let simulationWorker: Worker | undefined;
let simulationSerializer: Serializer | undefined;
let activeSystemId: string | undefined;
let roomSubscriptions: Subscription[] = [];
let pendingDockedShip: { uuid: string, entity: Entity, planetId: string } | undefined;
let dockedShip: { uuid: string, entity: Entity, planetId: string } | undefined;
let pendingLaunchedShip: Entity | undefined;
// Hypergate docking, mirroring the spaceport dock: the ship is removed from
// the sim while the hypergate map is open, then either transits (jumpTo) or
// relaunches at the gate.
let pendingGateShip: { uuid: string, entity: Entity, planetId: string } | undefined;
let gateDockedShip: { uuid: string, entity: Entity, planetId: string } | undefined;
let pendingGateLaunch: Entity | undefined;
// The gate the player is about to arrive through. Set just before the
// transit's jumpTo; the destination display world is told the moment it is
// created (GateArrivalAnticipationEvent) so the gate's opening animation
// gets a head start of the room join + insertion latency.
let pendingGateArrivalSpob: string | undefined;
let controls: Controls | undefined;
const controlsSubject = new Subject<ControlEvent>();
let autopilot: Autopilot | undefined;
let simulationTickInFlight = false;
let lastPumpDone: number | undefined;
let syncedPlayerJumpRoute: string[] | undefined;

// Fixed-timestep bookkeeping: real elapsed ms not yet simulated.
const MAX_CATCHUP_STEPS = 6;
let simulationTimeDebt = 0;
let lastPumpTime: number | undefined;
/**
 * Tick pacing against the room's clock (from the last frame). Small
 * drift is corrected by the rate factor — time runs imperceptibly
 * fast or slow. Only drift beyond SNAP_BEHIND_TICKS (a hidden tab, a
 * long stall) is snapped, bounded per frame by HARD_CATCHUP_STEPS.
 */
let simulationPacing: SimulationPacing | undefined;
const SNAP_BEHIND_TICKS = 30;
const HARD_CATCHUP_STEPS = 60;
/** Debug control over simulation stepping: `window.novaSim`. */
const simulationControl = {
    paused: false,
    pendingSteps: 0,
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    /** While paused, runs `count` simulation steps on the next frame. */
    step(count = 1) { this.pendingSteps += count; },
    /** Rolls the simulation back `ticks` (~60/s) and resimulates. */
    async rewind(ticks = 60) {
        return await simulationBridge?.rewind(ticks) ?? false;
    },
    /** Desync recovery: rebuild from genesis plus the room's input log. */
    async resync() {
        return await simulationBridge?.resync() ?? false;
    },
    /** The current clock slew against the room's tick, if any. */
    get pacing() { return simulationPacing; },
    /** Worker diagnostics: tick, desyncs, join result, recent logs. */
    async status() {
        return await simulationBridge?.status() ?? null;
    },
    /** Per-entity world hashes, for diffing against another client's
     * (or the server's archive dump on desync). */
    async hashes() {
        return await simulationBridge?.entityHashes() ?? null;
    },
    /** Debug: is the frame pump wedged on an await? */
    get inFlight() { return simulationTickInFlight; },
    /** Debug: wall-clock ms since the pump last completed a frame. */
    get sinceLastPump() {
        return lastPumpDone === undefined
            ? null : performance.now() - lastPumpDone;
    },
};
(window as any).novaSim = simulationControl;
const syncedComponents = new Map<string, Set<UnknownComponent>>();
const warnedUnsyncableEntities = new Set<string>();

function syncEntityToDisplay(uuid: string, encodedEntity: unknown, serializer: Serializer, displayWorld: World) {
    const decoded = serializer.decode(encodedEntity);
    if (isLeft(decoded)) {
        if (!warnedUnsyncableEntities.has(uuid)) {
            warnedUnsyncableEntities.add(uuid);
            console.warn(
                `Skipping entity ${uuid} because serializer decode failed: `
                + serializer.describeDecodeFailure(encodedEntity, decoded.left)
            );
        }
        return;
    }
    const syncedEntity = decoded.right;

    let displayEntity = displayWorld.entities.get(uuid);
    if (!displayEntity) {
        displayEntity = new Entity(syncedEntity.name);
        displayWorld.entities.set(uuid, displayEntity);
    } else if (displayEntity.name !== syncedEntity.name) {
        displayEntity.name = syncedEntity.name;
    }

    const previousComponents = syncedComponents.get(uuid) ?? new Set<UnknownComponent>();
    const nextComponents = new Set<UnknownComponent>(syncedEntity.components.keys());

    for (const [component, data] of syncedEntity.components) {
        displayEntity.components.set(component, data);
    }

    for (const component of previousComponents) {
        if (!nextComponents.has(component)) {
            displayEntity.components.delete(component);
        }
    }

    syncedComponents.set(uuid, nextComponents);
}

function applyEntityDelta(uuid: string, delta: EntityDelta, serializer: Serializer, displayWorld: World) {
    const displayEntity = displayWorld.entities.get(uuid);
    if (!displayEntity) {
        if (!warnedUnsyncableEntities.has(uuid)) {
            warnedUnsyncableEntities.add(uuid);
            console.warn(`Received a delta for entity ${uuid}, which is not in the display world`);
        }
        return;
    }

    if (delta.name !== undefined) {
        displayEntity.name = delta.name;
    }

    const synced = syncedComponents.get(uuid) ?? new Set<UnknownComponent>();
    syncedComponents.set(uuid, synced);
    for (const [componentName, encoded] of delta.changed) {
        const decoded = serializer.decodeComponent(componentName, encoded);
        if (!decoded) {
            continue;
        }
        if (isLeft(decoded)) {
            const warnKey = `${uuid} ${componentName}`;
            if (!warnedUnsyncableEntities.has(warnKey)) {
                warnedUnsyncableEntities.add(warnKey);
                console.warn(`Skipping component ${componentName} of entity ${uuid} because decode failed`);
            }
            continue;
        }
        const [component, data] = decoded.right;
        displayEntity.components.set(component, data);
        synced.add(component);
    }
    for (const componentName of delta.removed) {
        const component = serializer.componentsByName.get(componentName);
        if (!component) {
            continue;
        }
        displayEntity.components.delete(component);
        synced.delete(component);
    }
}

function applySimulationFrame(frame: SimulationFrame, serializer: Serializer, displayWorld: World) {
    for (const [uuid, entity] of frame.added) {
        syncEntityToDisplay(uuid, entity, serializer, displayWorld);
    }
    for (const [uuid, delta] of frame.changed) {
        applyEntityDelta(uuid, delta, serializer, displayWorld);
    }
    for (const uuid of frame.removed) {
        syncedComponents.delete(uuid);
        displayWorld.entities.delete(uuid);
    }

    // The simulation's time (frame.time) is NOT copied into the display
    // world's TimeResource: the simulation runs on fixed, 0-based
    // logical time, while the display world keeps wall-clock time for
    // smooth rendering. It is mirrored under a separate resource for
    // display systems that compare against sim-clock timestamps on
    // components (e.g. debris expiry).
    if (frame.time) {
        displayWorld.resources.set(SimulationTimeResource, frame.time);
    }
}

function getDisplayPlayerJumpRoute(displayWorld: World) {
    for (const entity of displayWorld.entities.values()) {
        if (!entity.components.has(PlayerShipSelector)) {
            continue;
        }
        const jumpRoute = entity.components.get(JumpRouteComponent);
        return jumpRoute?.route;
    }
    return undefined;
}

let prefetchedSystemId: string | undefined;
/**
 * Starts loading the destination system's data and sprite assets while
 * the jump sequence plays. Display-side only: the simulation never
 * waits on these loads. Arrival is inherently load-gated regardless —
 * jumpTo() builds the destination world (makeSystem loads its planets
 * and linked-system metadata) and completes the room join before the
 * player's ship is inserted, and that insertion is an input record, so
 * a slow load only delays the arrival tick without desyncing anyone.
 * Prefetching just shortens the time spent on the white screen.
 */
function prefetchJumpDestination(displayWorld: World) {
    for (const entity of displayWorld.entities.values()) {
        if (!entity.components.has(PlayerShipSelector)) {
            continue;
        }
        const jump = entity.components.get(JumpComponent);
        if (!jump || jump.stage === 'arriving'
            || prefetchedSystemId === jump.to) {
            return;
        }
        prefetchedSystemId = jump.to;
        void (async () => {
            try {
                const system = await simulationGameData.data.System.get(jump.to);
                await Promise.all([
                    ...system.links.map(link =>
                        simulationGameData.data.System.get(link)),
                    ...system.planets.map(async planetId => {
                        const planet =
                            await simulationGameData.data.Planet.get(planetId);
                        await Promise.all(
                            Object.values(planet.animation.images).flatMap(
                                image => [
                                    displayAssetData.data.SpriteSheetFrames
                                        .get(image.id),
                                    displayAssetData.data.SpriteSheetImage
                                        .get(image.id),
                                ]));
                    }),
                ]);
            } catch (e) {
                console.warn(`Failed to prefetch system ${jump.to}`, e);
            }
        })();
        return;
    }
}

function routesEqual(a?: string[], b?: string[]) {
    if (a === b) {
        return true;
    }
    if (!a || !b || a.length !== b.length) {
        return false;
    }
    return a.every((entry, index) => entry === b[index]);
}

/** Finds the local player's ship entity in the given display world. */
/**
 * Spawns the escorts hired in the bar (see pending_escorts.ts) as NPC
 * sim entities in formation on the relaunched player ship, through
 * the same input-record addEntity path the player entity itself uses
 * — deterministic across peers because the fully-built entity is
 * baked into the record. Slots continue after any followers the
 * player already has. In-system only: hired escorts do not follow
 * through hyperspace (documented gap; tied to future persistence
 * work).
 */
/** The first free formation slot on `leaderUuid` in the display
 * world (used to continue slot numbering across spawn batches). */
function nextFormationSlot(displayWorld: World, leaderUuid: string): number {
    let slot = 0;
    for (const entity of displayWorld.entities.values()) {
        const formation = entity.components.get(FormationComponent);
        if (formation?.leader === leaderUuid) {
            slot = Math.max(slot, formation.slot + 1);
        }
    }
    return slot;
}

async function spawnHiredEscorts(
    bridge: AsyncSimulationBridgeClient, displayWorld: World,
    leaderUuid: string, leader: Entity, shipIds: string[],
    ownerUuid?: string): Promise<void> {
    const movement = leader.components.get(MovementStateComponent);
    if (!movement) {
        console.warn('Hired escorts skipped: leader has no movement state');
        return;
    }
    // Continue slot numbering after existing followers (e.g. escorts
    // hired on an earlier landing this session).
    let slot = nextFormationSlot(displayWorld, leaderUuid);
    for (const shipId of shipIds) {
        try {
            const shipData = await simulationGameData.data.Ship.get(shipId);
            const position = formationSlotPosition(
                movement.position, movement.rotation, slot);
            const escort = makeNpcShip(shipData, 0, null, position,
                movement.rotation, new Vector(0, 0));
            escort.components.set(FormationComponent,
                { leader: leaderUuid, slot });
            // Fresh escorts start under the default escort command;
            // spawning here (on liftoff / system entry) IS the
            // "commands reset to formation" rule.
            escort.components.set(EscortCommandComponent,
                { command: 'formation' });
            // Hired escorts share the player's firing group so their shots
            // pass through the player (and vice versa via the owner-root
            // fallback) — same friendly-fire immunity as NPC fleets.
            escort.components.set(FiringGroupComponent,
                { group: leaderUuid });
            if (ownerUuid) {
                escort.components.set(MultiplayerData, { owner: ownerUuid });
            }
            await bridge.addEntity(v4(), escort);
            slot++;
        } catch (e) {
            console.warn(`Failed to spawn hired escort ${shipId}:`, e);
        }
    }
}

/**
 * Mission special/aux ships entering with the player — the owning
 * client's half of the multiplayer design in mission_ship_plugin.ts.
 * `prepareMissionShips` must run BEFORE the player entity is encoded
 * into its own insertion record: it clears the stale mission-ship
 * rosters on the entity (so the cleared state rides that record) and
 * builds the ships whose spawn system matches. `insertMissionShips`
 * then pushes them through the same input-record addEntity path as
 * hired escorts, after the owner is in (the goal systems track ships
 * against their owner's mission state).
 */
async function prepareMissionShips(playerEntity: Entity, playerUuid: string,
    systemId: string, firstSlot: number): Promise<Entity[]> {
    try {
        const universe = MissionUniverse.shared(simulationGameData);
        await universe.load();
        return await buildMissionShipSpawns(playerEntity, playerUuid,
            systemId, simulationGameData, universe, firstSlot);
    } catch (e) {
        console.warn('Failed to prepare mission ships:', e);
        return [];
    }
}

async function insertMissionShips(bridge: AsyncSimulationBridgeClient,
    ships: Entity[], ownerUuid?: string): Promise<void> {
    for (const ship of ships) {
        try {
            if (ownerUuid) {
                // Like hired escorts: peer-owned so removePeer cleans
                // them up if this client vanishes.
                ship.components.set(MultiplayerData, { owner: ownerUuid });
            }
            await bridge.addEntity(v4(), ship);
        } catch (e) {
            console.warn('Failed to spawn mission ship:', e);
        }
    }
}

function getPlayerShipEntity(displayWorld: World): Entity | undefined {
    for (const entity of displayWorld.entities.values()) {
        if (entity.components.has(PlayerShipSelector)) {
            return entity;
        }
    }
    return undefined;
}

/**
 * Serializes the local player's current state to localStorage. A pure
 * read of the display world's player entity (which mirrors the simulation),
 * so it's a safe observer that never mutates sim state. No-op if there's no
 * player ship yet (e.g. mid-jump) or nothing meaningful to persist.
 */
function saveNow() {
    if (!displayWorld || !activeSystemId) {
        return;
    }
    // While docked the player entity is out of the display world; the
    // docked/relaunching entity carries the freshest state (mission
    // acceptances, payments, the advanced date).
    const playerShip = pendingLaunchedShip
        ?? dockedShip?.entity
        ?? pendingDockedShip?.entity
        ?? getPlayerShipEntity(displayWorld);
    if (!playerShip) {
        return;
    }
    const data = extractSaveData(playerShip, activeSystemId);
    if (!data) {
        return;
    }
    writeSave(data);
}

let saveTriggersInstalled = false;
const SAVE_INTERVAL_MS = 10_000;

/**
 * Wires up when the game persists the player's state:
 * - periodically (every ~10s),
 * - when the page is being hidden or unloaded (pagehide / the tab going
 *   to the background), which are more reliable than beforeunload.
 * Landing at a spaceport also saves; that hook lives on each display
 * world's LeaveSpaceportEvent in jumpTo.
 */
function installSaveTriggers() {
    if (saveTriggersInstalled) {
        return;
    }
    saveTriggersInstalled = true;

    setInterval(saveNow, SAVE_INTERVAL_MS);

    // pagehide fires on navigation away / tab close and is far more
    // reliable than beforeunload (which browsers may skip).
    window.addEventListener('pagehide', saveNow);
    // Save whenever the tab is backgrounded: on mobile this is often the
    // last event before the page is discarded.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            saveNow();
        }
    });

    // Console-callable escape hatches.
    (window as any).novaSaveNow = saveNow;
    (window as any).novaResetSave = () => {
        resetSave();
        console.info('Cleared the saved game. Reload to start fresh.');
    };
}

async function makeDisplayWorld(systemId: string) {
    const displayWorld = new World(`${systemId} display`);
    displayWorld.resources.set(SimulationGameDataResource, simulationGameData);
    displayWorld.resources.set(DisplayAssetDataResource, displayAssetData);
    displayWorld.resources.set(PixiAppResource, app);
    displayWorld.resources.set(SystemIdResource, systemId);
    displayWorld.resources.set(ControlsSubject, controlsSubject);
    displayWorld.resources.set(CommunicatorResource, communicator);
    // The display world keeps its own wall-clock time for smooth
    // rendering. (The simulation runs on fixed, 0-based logical time,
    // which is no longer copied into the display world.)
    await displayWorld.addPlugin(TimePlugin);
    await displayWorld.addPlugin(Display);
    return displayWorld;
}

async function jumpTo({ entity, to, uuid }: { entity: Entity, to: string, uuid: string }) {
    autopilot?.cancel();
    document.body.classList.remove('nova-docked');
    pendingDockedShip = undefined;
    dockedShip = undefined;
    pendingLaunchedShip = undefined;
    pendingGateShip = undefined;
    gateDockedShip = undefined;
    pendingGateLaunch = undefined;
    syncedPlayerJumpRoute = undefined;
    if (simulationBridge) {
        // Detach the bridge from the pump BEFORE tearing it down, so
        // no new pump frame starts a call against the dying worker. A
        // frame already awaiting one is unwedged by close(), which
        // settles every in-flight call with SimulationBridgeClosedError
        // (the pump treats that as "a transition took my bridge").
        const oldBridge = simulationBridge;
        simulationBridge = undefined;
        simulationPacing = undefined;
        if (uuid) {
            await oldBridge.removeEntity(uuid);
        }
        await oldBridge.close();
    }
    simulationWorker = undefined;
    for (const subscription of roomSubscriptions) {
        subscription.unsubscribe();
    }
    roomSubscriptions = [];
    if (activeSystemId) {
        const stage = displayWorld?.resources.get(Stage);
        if (stage) {
            app.stage.removeChild(stage);
        }
        multiRoom.leave(activeSystemId);
        if (displayWorld) {
            await displayWorld.removePlugin(Display);
        }
        for (const uuid of syncedComponents.keys()) {
            displayWorld?.entities.delete(uuid);
        }
        syncedComponents.clear();
    }
    activeSystemId = to;

    const room = multiRoom.join(to);
    const serializerWorld = await makeSystem(to, simulationGameData, 'worker');
    const serializer = serializerWorld.resources.get(SerializerResource);
    if (!serializer) {
        throw new Error('Expected simulation serializer resource to exist');
    }
    simulationSerializer = serializer;

    const worker = new Worker("/simulation_bridge_browser_worker_bundle.js", {
        type: "module",
    });
    const { host, client: newSimulationBridge } = makeBrowserSimulationBridgeClient(
        worker,
        serializer,
    );
    simulationWorker = worker;

    // Forward room traffic to the worker BEFORE init: init awaits
    // joinRoom, whose catch-up reply arrives on this channel. With the
    // subscription after init, every join's reply was dropped and the
    // world silently started at tick 0 in a room with real history
    // (the first desync's resync then papered over it). The worker
    // buffers anything that arrives before its communicator exists.
    roomSubscriptions = [
        room.messages.subscribe(({ source, message }) => {
            void host.receiveRoomMessage(source, message);
        }),
        room.peers.current.subscribe(peers => {
            void host.updateRoomState({ peers });
        }),
        room.connected.subscribe(connected => {
            void host.updateRoomState({ connected });
        }),
    ];

    await host.init(
        {
            systemId: to,
            roomState: {
                uuid: room.uuid,
                peers: room.peers.current.value,
                connected: room.connected.value,
                servers: room.servers.value,
            },
        },
        Comlink.proxy(async (message, destination) => {
            room.sendMessage(message, destination);
        }),
    );

    const initialFrame = await newSimulationBridge.snapshot();
    const newDisplayWorld = await makeDisplayWorld(to);
    if (pendingGateArrivalSpob) {
        // Announce the incoming gate arrival before the room join completes:
        // the event is queued and processed once this world starts stepping
        // (its planets are inserted by then), opening the destination gate
        // ahead of the ship's appearance.
        newDisplayWorld.emit(GateArrivalAnticipationEvent,
            { spob: pendingGateArrivalSpob });
        pendingGateArrivalSpob = undefined;
    }
    (window as any).simulationWorker = worker;
    (window as any).displayWorld = newDisplayWorld;

    const newStage = newDisplayWorld.resources.get(Stage);
    if (!newStage) {
        throw new Error('World did not have Pixi Stage');
    }
    app.stage.addChild(newStage);
    newStage.visible = true;

    newDisplayWorld.events.get(LeaveSpaceportEvent).subscribe(({ data }) => {
        pendingLaunchedShip = data;
        document.body.classList.remove('nova-docked');
    });
    newDisplayWorld.events.get(AddEnemyEvent).subscribe(async ({ data }) => {
        const { shipId } = data;
        await simulationGameData.data.Ship.get(shipId);
        await newSimulationBridge.spawnNpc(shipId);
    });
    newDisplayWorld.events.get(SetJumpRouteEvent).subscribe(({ data }) => {
        syncedPlayerJumpRoute = data.route.slice();
        void newSimulationBridge.setPlayerJumpRoute(data.route);
    });
    newDisplayWorld.events.get(LandEvent).subscribe(({ data, entities }) => {
        if (pendingDockedShip || dockedShip || pendingGateShip || gateDockedShip) {
            return;
        }
        // The planet's data is warm here (makeSystem loaded every planet in
        // this system before the world stepped).
        const landedPlanet = simulationGameData.data.Planet.getCached(data.id);
        // Landing on a WORMHOLE transits immediately: the sim handles the
        // whole transfer (GateDepartureSystem -> GateTransitEvent) and
        // nothing docks or opens here.
        if (landedPlanet?.gate?.kind === 'wormhole') {
            return;
        }
        const playerShipRef = entities?.[0];
        const playerShipUuid = typeof playerShipRef === "string" ? playerShipRef : playerShipRef?.uuid;
        const playerShip = playerShipUuid ? newDisplayWorld.entities.get(playerShipUuid) : undefined;
        if (!playerShipUuid || !playerShip || !playerShip.components.has(PlayerShipSelector)) {
            return;
        }
        // Landing on a HYPERGATE docks the ship (removed from the system like
        // a spaceport landing) and opens the hypergate map, where the player
        // picks one of the gate's linked neighbors (or lifts back off).
        if (landedPlanet?.gate?.kind === 'hypergate') {
            pendingGateShip = {
                uuid: playerShipUuid,
                entity: playerShip,
                planetId: data.id,
            };
            return;
        }
        pendingDockedShip = {
            uuid: playerShipUuid,
            entity: playerShip,
            planetId: data.id,
        };
        // Landing is a natural save point.
        saveNow();
    });
    newDisplayWorld.events.get(FinishJumpEvent).subscribe(({ data }) => {
        // Every peer simulates every ship's jump; only follow it to
        // the new system if the jumping ship is the local player's.
        // (The event carries the ship, which the sim already removed
        // this frame, so the display entity cannot be consulted.)
        // Remote jumpers' departures need nothing from the display.
        if (!data.entity.components.has(PlayerShipSelector)) {
            return;
        }
        void (async () => {
            // A jump takes days (by ship mass, adjusted by any
            // "hyperspace speed mod" outfits); advance the player's
            // calendar while the entity is between simulations. The
            // date rides to peers with the re-added entity. The derived
            // ShipPhysicsComponent already sums the outfit mods; fall
            // back to the raw ship data if it isn't populated yet.
            try {
                const derived = data.entity.components
                    .get(ShipPhysicsComponent);
                let mass = derived?.mass;
                let speedMod = derived?.hyperspaceSpeedMod ?? 0;
                if (mass === undefined) {
                    const shipId = data.entity.components
                        .get(ShipComponent)?.id;
                    const physics = shipId
                        ? (await simulationGameData.data.Ship.get(shipId))
                            .physics
                        : undefined;
                    mass = physics?.mass ?? 100;
                    speedMod = physics?.hyperspaceSpeedMod ?? 0;
                }
                await advanceEntityDate(data.entity,
                    daysPerJump(mass, speedMod),
                    MissionUniverse.shared(simulationGameData));
            } catch (e) {
                console.warn('Failed to advance the date on jump:', e);
            }
            await jumpTo(data);
        })();
    });
    newDisplayWorld.events.get(GateTransitEvent).subscribe(({ data }) => {
        // Wormhole transit reuses the jump room-switch. Only the local
        // player follows it to the destination system (like a jump); the
        // sim already removed the carried ship this frame.
        if (!data.entity.components.has(PlayerShipSelector)) {
            return;
        }
        void gateTransit(data);
    });
    newDisplayWorld.events.get(LeaveGateMapEvent).subscribe(({ data }) => {
        // The hypergate map closed. With a destination picked, ride the jump
        // room switch to it; otherwise lift back off from the origin gate.
        if (!gateDockedShip) {
            return;
        }
        const { ship, destinationSpob } = data;
        if (!destinationSpob) {
            pendingGateLaunch = ship;
            return;
        }
        const docked = gateDockedShip;
        void (async () => {
            const to = await gateDestinationResolver.systemOf(destinationSpob);
            if (!to) {
                console.warn(`Hypergate destination ${destinationSpob} is not `
                    + `in any system; lifting off instead.`);
                pendingGateLaunch = ship;
                return;
            }
            // The arrival marker rides the re-insertion input record to every
            // peer; GateArrivalSystem in the destination world positions the
            // ship flying out of the arrival gate. The emergence angle is
            // null so the DESTINATION gate's own CustSndID (read there)
            // decides the fly-out direction; randomDraw backs it up when
            // that angle says "random".
            ship.components.set(GateArrivalComponent, {
                destinationSpob,
                emergenceAngle: null,
                randomDraw: Math.random(),
            });
            pendingGateArrivalSpob = destinationSpob;
            await jumpTo({ entity: ship, to, uuid: docked.uuid });
        })();
    });

    // Wait until the current peer set includes the server, without racing
    // between an immediate state check and a later join event subscription.
    await firstValueFrom(room.peers.current.pipe(filter(peers => peers.has('server'))));
    // Mission ships whose spawn system this is (or that follow the
    // player) jump in with the player. Prepared before the player
    // entity is encoded into its insertion record.
    const missionShips = entity.components.has(PlayerShipSelector)
        ? await prepareMissionShips(entity, uuid, to, 0) : [];
    await newSimulationBridge.addEntity(uuid, entity);
    if (entity.components.has(PlayerShipSelector)) {
        (window as any).myShip = entity;
    }
    await insertMissionShips(newSimulationBridge, missionShips,
        communicator.uuid ?? undefined);
    // The new bridge starts from a fresh delta stream, so drop any
    // bookkeeping from the previous system's sync.
    syncedComponents.clear();
    warnedUnsyncableEntities.clear();
    applySimulationFrame(initialFrame, serializer, newDisplayWorld);
    syncedPlayerJumpRoute = getDisplayPlayerJumpRoute(newDisplayWorld)?.slice();
    simulationBridge = newSimulationBridge;
    displayWorld = newDisplayWorld;
    // Debug toggles, e.g. novaDebug.showCollisionShapes = true. Settings
    // carry over when jumping rebuilds the display world.
    (window as any).novaDebug =
        new DebugSettings(newDisplayWorld, (window as any).novaDebug);
}

/**
 * Follows a hypergate/wormhole transit to its destination system. The sim
 * already chose the exit spöb (or a random draw for a link-less wormhole) and
 * tagged the ship with a GateArrivalComponent; here we resolve that spöb to its
 * containing system, patch a random wormhole's exit onto the arrival marker,
 * and reuse the jump room-switch to move the player there. GateArrivalSystem in
 * the destination world then teleports the ship to the arrival gate.
 */
async function gateTransit(data: {
    entity: Entity, uuid: string, fromSpob: string, destinationSpob: string | null,
}) {
    const arrival = data.entity.components.get(GateArrivalComponent);
    let destinationSpob = data.destinationSpob;
    if (!destinationSpob) {
        // Random wormhole: resolve the exit from the full link-less-wormhole
        // list using the sim's replicated random draw.
        destinationSpob = (await gateDestinationResolver.randomWormholeExit(
            data.fromSpob, arrival?.randomDraw ?? 0)) ?? null;
        if (arrival && destinationSpob) {
            // Record the resolved exit so GateArrivalSystem can position the
            // ship at it in the destination world.
            data.entity.components.set(GateArrivalComponent, {
                ...arrival,
                destinationSpob,
            });
        }
    }
    if (!destinationSpob) {
        console.warn(`Gate transit from ${data.fromSpob} had no resolvable `
            + `destination; staying put.`);
        data.entity.components.delete(GateArrivalComponent);
        return;
    }
    const to = await gateDestinationResolver.systemOf(destinationSpob);
    if (!to) {
        console.warn(`Gate destination spöb ${destinationSpob} is not in any `
            + `system; staying put.`);
        data.entity.components.delete(GateArrivalComponent);
        return;
    }
    pendingGateArrivalSpob = destinationSpob;
    await jumpTo({ entity: data.entity, to, uuid: data.uuid });
}

async function startGame() {
    world = new World();
    world.resources.set(SimulationGameDataResource, simulationGameData);
    await world.addPlugin(multiplayer(multiRoom.join('main room')));
    world.resources.set(MultiRoomResource, multiRoom);
    await world.addPlugin(NovaPlugin);
    const controlsJson = await simulationGameData.getSettings?.('controls.json');
    if (!controlsJson) {
        throw new Error("Expected controls settings to exist");
    }
    const decodedControls = SavedControls.pipe(Controls).decode(controlsJson);
    if (isLeft(decodedControls)) {
        console.error(decodedControls.left);
        throw new Error("Failed to parse controls");
    }
    controls = decodedControls.right;

    // Make the player's ship
    while (!communicator.uuid) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const ids = await simulationGameData.ids;
    const query = new URLSearchParams(window.location.search);

    // ?reset wipes the save before we read it, so a bad session can be
    // recovered by adding &reset to the URL.
    if (query.has('reset')) {
        resetSave();
        console.info('Cleared the saved game (?reset).');
    }

    // The saved game (if any) provides defaults; explicit URL params
    // override it. A corrupt or old-version save is quarantined by
    // loadSave and we fall back to defaults.
    const save = loadSave();

    // A fresh pilot starts from a chär "player start": ship, credits,
    // date, systems, and its OnStart control bits. ?char=nova:129
    // picks one; otherwise the scenario's default.
    let playerStart;
    try {
        const requestedChar = query.get('char');
        if (ids.PlayerStart.length > 0) {
            const starts = await Promise.all(ids.PlayerStart.map(
                id => simulationGameData.data.PlayerStart.get(id)));
            playerStart = (requestedChar
                && starts.find(s => s.id === requestedChar))
                || starts.find(s => s.isDefault)
                || starts[0];
        }
    } catch (e) {
        console.warn('Failed to load player starts:', e);
    }

    // ?ship=nova:164 picks the player's ship; otherwise the saved ship,
    // otherwise the chär's starting ship, otherwise a random one.
    const requestedShip = query.get('ship');
    const savedShipValid = save && ids.Ship.includes(save.ship);
    const startShipValid =
        playerStart && ids.Ship.includes(playerStart.ship);
    let shipId = savedShipValid
        ? save!.ship
        : startShipValid
            ? playerStart!.ship
            : ids.Ship[Math.floor(Math.random() * ids.Ship.length)];
    // Only restore outfits when we actually use the saved ship: outfits
    // belong to a specific ship type.
    let usingSavedShip = savedShipValid;
    if (requestedShip) {
        if (ids.Ship.includes(requestedShip)) {
            shipId = requestedShip;
            usingSavedShip = save?.ship === requestedShip;
        } else {
            console.warn(`Unknown ship id '${requestedShip}'. Using ${shipId}.`);
        }
    }
    const shipData = await simulationGameData.data.Ship.get(shipId);
    const shipEntity = makeShip(shipData);
    // Restore owned outfits onto the ship. The staging derivers skip a
    // component that is already present, so setting OutfitsStateComponent
    // here preserves the saved loadout instead of the ship's stock one.
    if (usingSavedShip && save && save.outfits.length > 0) {
        shipEntity.components.set(OutfitsStateComponent,
            new Map(save.outfits.map(([id, count]) => [id, { count }])));
    }
    shipEntity.components.set(MultiplayerData, {
        owner: communicator.uuid
    });
    shipEntity.components.set(PlayerShipSelector, undefined);
    shipEntity.components.set(ControlledByComponent, { peerId: communicator.uuid });

    // Player state: restore it from the save, or start a fresh pilot
    // from the chär (credits, date, OnStart control bits, starting
    // legal statuses and combat rating).
    if (save) {
        restorePlayerState(shipEntity, save);
    } else if (playerStart) {
        // chär Govt1-4/Status1-4: the status applies to the govt and
        // its allies, negated for its enemies (reputation.ts). The
        // pilot-file importer extracts the same shape, so a future
        // pilot import lands here too.
        try {
            const govtIds = [...ids.Govt].sort();
            const allGovts = await Promise.all(govtIds.map(async id =>
                [id, await simulationGameData.data.Govt.get(id)] as const));
            shipEntity.components.set(LegalRecordsComponent,
                initialRecordsFromGovtStatuses(
                    playerStart.govtStatuses, allGovts));
        } catch (e) {
            console.warn('Failed to set starting legal records:', e);
        }
        shipEntity.components.set(CombatRatingComponent,
            { kills: Math.max(0, playerStart.combatRating) });
        shipEntity.components.set(GameDateComponent,
            { ...playerStart.date });
        shipEntity.components.set(CreditsComponent,
            { credits: playerStart.credits });
        const bits = new Set<number>();
        try {
            // New-pilot setup is player-local; plain randomness is
            // fine for R(a b) here (see the outfitter's runSetString).
            runNCBSet(playerStart.onStart, makeControlBitHooks(bits),
                Math.random);
        } catch (e) {
            if (e instanceof NCBParseError) {
                console.warn('Bad chär OnStart string:', e);
            } else {
                throw e;
            }
        }
        shipEntity.components.set(ControlBitsComponent, bits);
    }
    ensurePlayerStateComponents(shipEntity);
    (window as any).myShip = shipEntity;

    // ?system=nova:131 picks the starting system; otherwise the saved
    // system, otherwise the chär's start system, otherwise the default.
    const requestedSystem = query.get('system');
    const startSystems = playerStart?.systems.filter(
        id => ids.System.includes(id)) ?? [];
    let systemId = (save && ids.System.includes(save.system))
        ? save.system
        : startSystems.length > 0
            ? startSystems[Math.floor(Math.random() * startSystems.length)]
            : 'nova:130';
    if (requestedSystem) {
        if (ids.System.includes(requestedSystem)) {
            systemId = requestedSystem;
        } else {
            console.warn(`Unknown system id '${requestedSystem}'. Using ${systemId}.`);
        }
    }

    await jumpTo({
        entity: shipEntity,
        to: systemId,
        uuid: v4(),
    });

    // Warm the mission/cron/planet caches in the background so the
    // first landing or jump doesn't stall on them. Deliberately after
    // the initial join: these ~2000 fetches share Chrome's per-host
    // connection pool with the world-load fetches above.
    void MissionUniverse.shared(simulationGameData).load().catch(e => {
        console.warn('Failed to preload mission data:', e);
    });

    installSaveTriggers();

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
        displayWorld?.emit(ResizeEvent, { x: window.innerWidth, y: window.innerHeight });
    }
    window.onresize = resize;

    const stats = new Stats();
    document.body.appendChild(stats.dom);

    //(window as any).novaDebug = new DebugSettings(activeSystem);

    function emitControlEvents(controlEvents: ControlEvent[]) {
        if (controlEvents.length === 0) {
            return;
        }
        displayWorld?.emit(EcsControlEvent, controlEvents);
        for (const controlEvent of controlEvents) {
            controlsSubject.next(controlEvent);
        }
        void simulationBridge?.controlEvents(controlEvents);
    }

    const controlSinks: ControlSinks = {
        controlEvents: emitControlEvents,
        analogControl(control: AnalogControlState) {
            void simulationBridge?.analogControl(control);
        },
    };
    autopilot = new Autopilot(controlSinks);
    const localAutopilot = autopilot;
    // Console lever for tests/debugging (novaAutopilot.destination etc.).
    (window as any).novaAutopilot = autopilot;
    // Console lever for tests/debugging: inject control events directly
    // (bypassing the keyboard), e.g.
    //   novaControls.send([{action: 'nearestTarget', state: 'start'}])
    // followed by the matching {state: false} release.
    (window as any).novaControls = { send: emitControlEvents };

    // User movement input cancels the autopilot (the autopilot's own
    // inputs go through controlSinks directly and don't loop back
    // here). Firing and targeting deliberately don't cancel, so the
    // player can defend themselves on the way to a planet.
    const movementActions = new Set<string>(['accelerate', 'turnLeft',
        'turnRight', 'reverse', 'pointTo', 'land', 'hyperjump',
        'afterburner', 'board']);

    function handleControlEvent(event: KeyboardEvent) {
        if (!controls) {
            return;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
        }
        const actions = getActions(controls, event);
        if (actions.some(action => movementActions.has(action))) {
            localAutopilot.cancel();
        }
        const controlEvents: ControlEvent[] = actions.map(action => ({
            action,
            state: event.type === 'keyup' ? false : event.repeat ? 'repeat' : 'start',
        }));
        emitControlEvents(controlEvents);
    }
    document.addEventListener('keydown', handleControlEvent);
    document.addEventListener('keyup', handleControlEvent);

    if (wantsTouchControls()) {
        installTouchControls({
            sinks: controlSinks,
            onMovementInput: () => localAutopilot.cancel(),
        });
    }

    // Tap or click on a ship to target it; on a planet to autopilot
    // there and land.
    installTapTargeting(app.view as unknown as HTMLElement, {
        getWorld: () => displayWorld,
        getMyPeerId: () => communicator.uuid ?? undefined,
        targetShip: uuid => void simulationBridge?.setTarget(uuid),
        navigateToPlanet: uuid => localAutopilot.navigateTo(uuid),
    });

    async function pumpSimulationFrame() {
        if (simulationTickInFlight) {
            return;
        }
        if (!simulationBridge || !displayWorld || !simulationSerializer) {
            return;
        }
        simulationTickInFlight = true;
        stats.begin();
        const currentBridge = simulationBridge;
        const currentDisplayWorld = displayWorld;
        const currentSerializer = simulationSerializer;
        try {
            world.step();
            localAutopilot.step(displayWorld, communicator.uuid ?? undefined);
            if (pendingDockedShip && !dockedShip) {
                await currentBridge.removeEntity(pendingDockedShip.uuid);
                currentDisplayWorld.emit(OpenSpaceportEvent, {
                    planetId: pendingDockedShip.planetId,
                    ship: pendingDockedShip.entity,
                });
                // Hide the touch controls under the spaceport UI.
                document.body.classList.add('nova-docked');
                dockedShip = pendingDockedShip;
                pendingDockedShip = undefined;
            }
            if (pendingLaunchedShip && dockedShip) {
                // A ship bought at the shipyard is a fresh entity: it
                // must carry the multiplayer identity or no peer's
                // inputs steer it (and removePeer never cleans it up).
                if (communicator.uuid) {
                    pendingLaunchedShip.components.set(ControlledByComponent,
                        { peerId: communicator.uuid });
                    pendingLaunchedShip.components.set(MultiplayerData,
                        { owner: communicator.uuid });
                }
                // Escorts hired in the bar spawn alongside the
                // relaunched player ship. The pending list is
                // display-side bookkeeping; pop it before the entity
                // is encoded into the addEntity input record.
                const pendingEscorts =
                    pendingLaunchedShip.components.get(PendingEscortsComponent);
                pendingLaunchedShip.components.delete(PendingEscortsComponent);
                // Mission ships spawn alongside the relaunch; prepared
                // before the player entity is encoded (see
                // prepareMissionShips), inserted after it.
                const missionShips = await prepareMissionShips(
                    pendingLaunchedShip, dockedShip.uuid,
                    activeSystemId ?? '',
                    nextFormationSlot(currentDisplayWorld, dockedShip.uuid)
                    + (pendingEscorts?.length ?? 0));
                await currentBridge.addEntity(dockedShip.uuid, pendingLaunchedShip);
                if (pendingEscorts && pendingEscorts.length > 0) {
                    await spawnHiredEscorts(currentBridge,
                        currentDisplayWorld, dockedShip.uuid,
                        pendingLaunchedShip, pendingEscorts,
                        communicator.uuid ?? undefined);
                }
                await insertMissionShips(currentBridge, missionShips,
                    communicator.uuid ?? undefined);
                if (pendingLaunchedShip.components.has(PlayerShipSelector)) {
                    (window as any).myShip = pendingLaunchedShip;
                }
                dockedShip = undefined;
                pendingLaunchedShip = undefined;
            }
            // Hypergate docking, mirroring the spaceport dock above: remove
            // the landed ship from the sim and open the hypergate map.
            if (pendingGateShip && !gateDockedShip) {
                await currentBridge.removeEntity(pendingGateShip.uuid);
                currentDisplayWorld.emit(OpenGateMapEvent, {
                    gateSpob: pendingGateShip.planetId,
                    systemId: activeSystemId ?? '',
                    ship: pendingGateShip.entity,
                });
                gateDockedShip = pendingGateShip;
                pendingGateShip = undefined;
            }
            // The map closed without a destination: lift back off from the
            // gate into the origin system (nothing strands the ship).
            if (pendingGateLaunch && gateDockedShip) {
                // Mission ships despawned while gate-docked; respawn
                // them with the lift-off (same shape as the spaceport
                // launch above).
                const gateMissionShips = await prepareMissionShips(
                    pendingGateLaunch, gateDockedShip.uuid,
                    activeSystemId ?? '', nextFormationSlot(
                        currentDisplayWorld, gateDockedShip.uuid));
                await currentBridge.addEntity(
                    gateDockedShip.uuid, pendingGateLaunch);
                await insertMissionShips(currentBridge, gateMissionShips,
                    communicator.uuid ?? undefined);
                if (pendingGateLaunch.components.has(PlayerShipSelector)) {
                    (window as any).myShip = pendingGateLaunch;
                }
                gateDockedShip = undefined;
                pendingGateLaunch = undefined;
            }
            // The simulation runs on a fixed timestep, so convert real
            // elapsed time into a whole number of simulation steps and
            // carry the remainder. Render rate and simulation rate are
            // independent.
            const now = performance.now();
            if (lastPumpTime !== undefined && !simulationControl.paused) {
                // Slew toward the room's clock: elapsed time counts
                // slightly fast or slow rather than ticks being
                // skipped or doubled.
                simulationTimeDebt +=
                    (now - lastPumpTime) * (simulationPacing?.rate ?? 1);
            }
            lastPumpTime = now;
            // If we fall behind (heavy load, background tab), run at most
            // a few catch-up steps rather than spiraling.
            simulationTimeDebt = Math.min(
                simulationTimeDebt, SIMULATION_STEP_MS * MAX_CATCHUP_STEPS);
            let steps = Math.floor(simulationTimeDebt / SIMULATION_STEP_MS);
            simulationTimeDebt -= steps * SIMULATION_STEP_MS;
            if (simulationControl.paused) {
                steps = simulationControl.pendingSteps;
                simulationControl.pendingSteps = 0;
                simulationTimeDebt = 0;
            } else if (simulationPacing
                && simulationPacing.behindTicks > SNAP_BEHIND_TICKS) {
                // Too far behind the room to slew: snap by stepping
                // the backlog, bounded per frame.
                steps += Math.min(Math.floor(simulationPacing.behindTicks),
                    HARD_CATCHUP_STEPS);
            }

            if (steps > 0) {
                await currentBridge.step(steps);
                const frame = await currentBridge.snapshot();
                if (currentBridge !== simulationBridge || currentDisplayWorld !== displayWorld) {
                    return;
                }
                applySimulationFrame(frame, currentSerializer, currentDisplayWorld);
                simulationPacing = frame.pacing;
                syncedPlayerJumpRoute = getDisplayPlayerJumpRoute(currentDisplayWorld)?.slice();
                prefetchJumpDestination(currentDisplayWorld);
                for (const event of frame.events) {
                    emitSimulationBridgeEvent(event, currentSerializer, currentDisplayWorld);
                }
            }
            currentDisplayWorld.step();
            const displayedJumpRoute = getDisplayPlayerJumpRoute(currentDisplayWorld);
            if (!routesEqual(displayedJumpRoute, syncedPlayerJumpRoute)) {
                await currentBridge.setPlayerJumpRoute(displayedJumpRoute ?? []);
                syncedPlayerJumpRoute = displayedJumpRoute?.slice() ?? [];
            }
        } catch (e) {
            // A system transition (jumpTo) closes the bridge this frame
            // captured; its in-flight calls settle with
            // SimulationBridgeClosedError. That is expected — bail out
            // and let the next frame pick up the new bridge. Anything
            // else is a real error, but the pump must never die (a
            // frame pump that stops ends the game), so log and go on.
            if (!(e instanceof SimulationBridgeClosedError
                || currentBridge !== simulationBridge)) {
                console.error('Simulation frame pump error:', e);
            }
        } finally {
            simulationTickInFlight = false;
            lastPumpDone = performance.now();
            stats.end();
        }
    }

    app.ticker.add(() => {
        void pumpSimulationFrame();
    });

    // A fully backgrounded (or occluded) window gets zero rAF, so the
    // ticker — and with it the frame pump — freezes: the peer stays in
    // the room but stops stepping, publishing inputs, and reporting
    // hashes, a zombie that only revives on refocus. Worker timers are
    // exempt from background throttling, so a tiny worker heartbeat
    // drives the ticker whenever real rAF stalls. The staleness check
    // covers occluded-but-not-hidden windows, and keeps the heartbeat
    // from stacking on healthy rAF (which would run the sim fast).
    let lastAnimationFrame = performance.now();
    const animationFrameAlive = () => {
        lastAnimationFrame = performance.now();
        requestAnimationFrame(animationFrameAlive);
    };
    requestAnimationFrame(animationFrameAlive);
    const pumpWorker = new Worker(URL.createObjectURL(new Blob(
        ['setInterval(() => postMessage(0), 16)'],
        { type: 'text/javascript' })));
    pumpWorker.onmessage = () => {
        if (document.hidden
            || performance.now() - lastAnimationFrame > 100) {
            app.ticker.update(performance.now());
        }
    };
}

startGame()
