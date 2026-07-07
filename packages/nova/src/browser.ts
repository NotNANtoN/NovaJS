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
    SimulationFrame,
    SimulationPacing,
} from "./communication/simulation_bridge.js";
import { SocketChannelClient } from "./communication/socket_channel_client.js";
import { DebugSettings } from "./debug_settings.js";
import { Display } from "./display/display_plugin.js";
import { PixiAppResource } from "./display/pixi_app_resource.js";
import { ResizeEvent } from "./display/screen_size_plugin.js";
import { SetJumpRouteEvent } from "./display/starmap_plugin.js";
import { LeaveSpaceportEvent, OpenSpaceportEvent } from "./display/spaceport_plugin.js";
import { Stage } from "./display/stage_resource.js";
import { AddEnemyEvent } from "./display/status_bar.js";
import { ControlEvent, ControlsSubject, EcsControlEvent } from "./nova_plugin/controls_plugin.js";
import { Controls, getActions, SavedControls } from "./nova_plugin/controls.js";
import { DisplayAssetDataResource, SimulationGameDataResource } from "./nova_plugin/game_data_resource.js";
import { FinishJumpEvent, JumpRouteComponent } from "./nova_plugin/jump_plugin.js";
import { makeShip } from "./nova_plugin/make_ship.js";
import { makeSystem, SIMULATION_STEP_MS } from "./nova_plugin/make_system.js";
import { MultiRoomResource, NovaPlugin } from "./nova_plugin/nova_plugin.js";
import { LandEvent } from "./nova_plugin/planet_plugin.js";
import { PlayerShipSelector } from "./nova_plugin/player_ship_plugin.js";
import { ControlledByComponent } from "./nova_plugin/ship_control.js";
import { SystemIdResource } from "./nova_plugin/system_id_resource.js";


const simulationGameData = new SimulationGameData();
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
let controls: Controls | undefined;
const controlsSubject = new Subject<ControlEvent>();
let simulationTickInFlight = false;
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

    // Note: the simulation's time (frame.time) is NOT copied into the
    // display world. The simulation runs on fixed, 0-based logical time,
    // while the display world keeps wall-clock time for smooth rendering.
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

function routesEqual(a?: string[], b?: string[]) {
    if (a === b) {
        return true;
    }
    if (!a || !b || a.length !== b.length) {
        return false;
    }
    return a.every((entry, index) => entry === b[index]);
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
    pendingDockedShip = undefined;
    dockedShip = undefined;
    pendingLaunchedShip = undefined;
    syncedPlayerJumpRoute = undefined;
    if (simulationBridge) {
        if (uuid) {
            await simulationBridge.removeEntity(uuid);
        }
        await simulationBridge.close();
        simulationBridge = undefined;
        simulationPacing = undefined;
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
        if (pendingDockedShip || dockedShip) {
            return;
        }
        const playerShipRef = entities?.[0];
        const playerShipUuid = typeof playerShipRef === "string" ? playerShipRef : playerShipRef?.uuid;
        const playerShip = playerShipUuid ? newDisplayWorld.entities.get(playerShipUuid) : undefined;
        if (!playerShipUuid || !playerShip || !playerShip.components.has(PlayerShipSelector)) {
            return;
        }
        pendingDockedShip = {
            uuid: playerShipUuid,
            entity: playerShip,
            planetId: data.id,
        };
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
        void jumpTo(data);
    });

    // Wait until the current peer set includes the server, without racing
    // between an immediate state check and a later join event subscription.
    await firstValueFrom(room.peers.current.pipe(filter(peers => peers.has('server'))));
    await newSimulationBridge.addEntity(uuid, entity);
    if (entity.components.has(PlayerShipSelector)) {
        (window as any).myShip = entity;
    }
    // The new bridge starts from a fresh delta stream, so drop any
    // bookkeeping from the previous system's sync.
    syncedComponents.clear();
    warnedUnsyncableEntities.clear();
    applySimulationFrame(initialFrame, serializer, newDisplayWorld);
    syncedPlayerJumpRoute = getDisplayPlayerJumpRoute(newDisplayWorld)?.slice();
    simulationBridge = newSimulationBridge;
    displayWorld = newDisplayWorld;
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
    // ?ship=nova:164 picks the player's ship; otherwise it's random.
    const query = new URLSearchParams(window.location.search);
    const requestedShip = query.get('ship');
    let shipId = ids.Ship[Math.floor(Math.random() * ids.Ship.length)];
    if (requestedShip) {
        if (ids.Ship.includes(requestedShip)) {
            shipId = requestedShip;
        } else {
            console.warn(`Unknown ship id '${requestedShip}'. Using random ship ${shipId}.`);
        }
    }
    const shipData = await simulationGameData.data.Ship.get(shipId);
    const shipEntity = makeShip(shipData);
    shipEntity.components.set(MultiplayerData, {
        owner: communicator.uuid
    });
    shipEntity.components.set(PlayerShipSelector, undefined);
    shipEntity.components.set(ControlledByComponent, { peerId: communicator.uuid });
    (window as any).myShip = shipEntity;
    // ?system=nova:131 picks the starting system.
    const requestedSystem = query.get('system');
    let systemId = 'nova:130';
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

    function handleControlEvent(event: KeyboardEvent) {
        if (!controls) {
            return;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
        }
        const actions = getActions(controls, event);
        if (actions.length === 0) {
            return;
        }
        const controlEvents: ControlEvent[] = actions.map(action => ({
            action,
            state: event.type === 'keyup' ? false : event.repeat ? 'repeat' : 'start',
        }));
        displayWorld?.emit(EcsControlEvent, controlEvents);
        for (const controlEvent of controlEvents) {
            controlsSubject.next(controlEvent);
        }
        void simulationBridge?.controlEvents(controlEvents);
    }
    document.addEventListener('keydown', handleControlEvent);
    document.addEventListener('keyup', handleControlEvent);

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
            if (pendingDockedShip && !dockedShip) {
                await currentBridge.removeEntity(pendingDockedShip.uuid);
                currentDisplayWorld.emit(OpenSpaceportEvent, {
                    planetId: pendingDockedShip.planetId,
                    ship: pendingDockedShip.entity,
                });
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
                await currentBridge.addEntity(dockedShip.uuid, pendingLaunchedShip);
                if (pendingLaunchedShip.components.has(PlayerShipSelector)) {
                    (window as any).myShip = pendingLaunchedShip;
                }
                dockedShip = undefined;
                pendingLaunchedShip = undefined;
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
        } finally {
            simulationTickInFlight = false;
            stats.end();
        }
    }

    app.ticker.add(() => {
        void pumpSimulationFrame();
    });
}

startGame()
