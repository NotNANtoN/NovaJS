import { Entity } from "nova_ecs/entity";
import { Position } from "nova_ecs/datatypes/position";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { multiplayer, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { resetWallClock, TimeResource } from "nova_ecs/plugins/time_plugin";
import { World } from "nova_ecs/world";
import { isRight } from "fp-ts/Either";
import * as PIXI from "pixi.js";
import { firstValueFrom, take, filter, map, timeout } from "rxjs";
import Stats from 'stats.js';
import { v4 } from "uuid";
import { GameData } from "./client/gamedata/GameData";
import { CommunicatorClient } from "./communication/CommunicatorClient";
import { MultiRoom } from "./communication/multi_room_communicator";
import { SocketChannelClient } from "./communication/SocketChannelClient";
import { DebugSettings } from "./debug_settings";
import { Display } from "./display/display_plugin";
import {
    getTitleMusicState,
    startTitleMusicOnGesture,
    stopTitleMusic,
} from "./display/music";
import { PixiAppResource } from "./display/pixi_app_resource";
import { ResizeEvent } from "./display/screen_size_plugin";
import { Stage } from "./display/stage_resource";
import { GameDataResource } from "./nova_plugin/game_data_resource";
import {
    FinishJumpEvent,
    restartJumpArrival,
} from "./nova_plugin/jump_plugin";
import {
    PlayerDeathComponent,
    PlayerDestructionCompleteEvent,
    RespawnRelocationEvent,
} from "./nova_plugin/death_plugin";
import { makeShip } from "./nova_plugin/make_ship";
import { makeSystem } from "./nova_plugin/make_system";
import { MultiRoomResource, NovaPlugin, SystemComponent } from "./nova_plugin/nova_plugin";
import { PlayerShipSelector } from "./nova_plugin/player_ship_plugin";
import { CompatibilityProfile } from "./nova_plugin/entity_budget";
import {
    PlayerData,
    PlayerSnapshotSummary,
    PlayerState,
    PlayerStateComponent,
    PlayerStateResource,
    setCargoCapacity,
} from "./nova_plugin/player_state";
import { SystemIdResource } from "./nova_plugin/system_id_resource";
import {
    EscapeMenu,
    StartMenu,
    StartMenuSelection,
} from "./client/start_menu";


const gameData = new GameData();
(window as any).gameData = gameData;
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
    autoDensity: true,
    // Keep the back buffer readable for diagnostics and automated probes.
    preserveDrawingBuffer: true,
});

(window as any).app = app;
(window as any).novaTitleMusicState = getTitleMusicState;
document.body.appendChild(app.view as any);
startTitleMusicOnGesture();

const channel = new SocketChannelClient({});
const communicator = new CommunicatorClient(channel);
(window as any).communicator = communicator;
const multiRoom = new MultiRoom(communicator);
(window as any).multiRoom = multiRoom;

// New servers send this after the normal communicator UUID handshake. The
// timeout keeps clients compatible with older servers that do not send it.
const playerDataPromise = firstValueFrom(communicator.messages.pipe(
    filter(({ source }) => source === 'server'),
    map(({ message }) => {
        const directData = PlayerData.decode(message);
        if (isRight(directData)) {
            return directData;
        }
        // ServerPlugin runs on the main-room communicator, which wraps
        // regular messages in { room, message } for the wire protocol.
        if (message && typeof message === 'object' && 'message' in message) {
            return PlayerData.decode(message.message);
        }
        return directData;
    }),
    filter(isRight),
    map(decoded => decoded.right),
    take(1),
    timeout({ first: 1000 }),
)).catch(() => undefined);

async function loadCompatibilityProfile(): Promise<CompatibilityProfile> {
    try {
        const settings = await gameData.getSettings('game.json');
        if (settings && typeof settings === 'object'
            && 'compatibilityProfile' in settings
            && ((settings as { compatibilityProfile?: unknown })
                .compatibilityProfile === 'classic')) {
            return 'classic';
        }
    } catch {
        // Older servers do not have game.json; modern is the safe default.
    }
    return 'modern';
}

async function loadControlSettings(): Promise<unknown> {
    try {
        return await gameData.getSettings('controls.json');
    } catch {
        return undefined;
    }
}

async function loadPersistedPlayerData(): Promise<PlayerData | undefined> {
    try {
        const response = await fetch(
            `/player/state?token=${encodeURIComponent(channel.playerToken)}`);
        if (!response.ok) {
            return undefined;
        }
        const decoded = PlayerData.decode(await response.json() as unknown);
        return isRight(decoded) ? decoded.right : undefined;
    } catch {
        return undefined;
    }
}

async function waitForCommunicatorUuid() {
    const deadline = Date.now() + 5_000;
    while (!communicator.uuid && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!communicator.uuid) {
        throw new Error('Communicator handshake did not complete');
    }
}

let world: World | undefined;
let system: World | undefined;
let compatibilityProfile: CompatibilityProfile = 'modern';
let controlSettings: unknown;
let gameRunning = false;
let gamePaused = true;
let tickerInstalled = false;
let mainRoomJoined = false;
let mainMenuTransitioning = false;

function resetGameplayClocks() {
    for (const gameplayWorld of [world, system]) {
        const time = gameplayWorld?.resources.get(TimeResource);
        if (time) {
            resetWallClock(time);
        }
    }
}

function resumeGameplay() {
    resetGameplayClocks();
    gamePaused = false;
}

async function leaveGameWorld() {
    if (!system) {
        return;
    }
    for (const uuid of [...system.entities.keys()]) {
        if (uuid !== 'singleton') {
            system.entities.delete(uuid);
        }
    }
    system.step(); // Let peers know the entity was removed
    const stage = system.resources.get(Stage);
    if (stage) {
        app.stage.removeChild(stage);
    }
    const currentSystemUuid = system.resources.get(SystemIdResource);
    if (currentSystemUuid) {
        multiRoom.leave(currentSystemUuid);
        world?.entities.delete(currentSystemUuid);
    }
    // Removing every non-base plugin also unsubscribes the multiplayer
    // communicator, so the old world cannot continue receiving room events.
    await system.removeAllPlugins();
    system = undefined;
}

type SystemTransitionCause = 'initial' | 'hyperjump' | 'respawn';

async function transitionTo(
    { entity, to, uuid }: { entity: Entity, to: string, uuid: string },
    cause: SystemTransitionCause,
) {
    if (system) {
        await leaveGameWorld();
    }

    const newSystem = makeSystem(to, gameData, undefined, compatibilityProfile);
    (window as any).novaDebug = new DebugSettings(newSystem, (window as any).novaDebug);

    (window as any).system = newSystem;
    newSystem.resources.set(PixiAppResource, app);
    await newSystem.addPlugin(Display);

    const newStage = newSystem.resources.get(Stage);
    if (!newStage) {
        throw new Error('World did not have Pixi Stage');
    }
    app.stage.addChild(newStage);
    newStage.visible = true;

    const room = multiRoom.join(to);
    await newSystem.addPlugin(multiplayer(room));

    newSystem.events.get(FinishJumpEvent).subscribe(transition =>
        void transitionTo(transition, 'hyperjump'));
    newSystem.events.get(RespawnRelocationEvent).subscribe(transition =>
        void transitionTo(transition, 'respawn'));
    newSystem.events.get(PlayerDestructionCompleteEvent)
        .subscribe(({ playerUuid }) => {
            if (playerUuid !== uuid || !gameRunning) {
                return;
            }
            const death = entity.components.get(PlayerDeathComponent);
            if (death?.outcome !== 'killed') {
                return;
            }
            void returnToMainMenu(
                entity.components.get(PlayerStateComponent));
        });

    if (!world) {
        throw new Error('Game world was not initialized');
    }
    world.entities.set(to, new Entity()
        .addComponent(SystemComponent, newSystem));

    // Wait for the server to connect
    if (!room.peers.current.value.has('server')) {
        await firstValueFrom(room.peers.join.pipe(filter(a => a === 'server')));
    }
    if (cause === 'hyperjump') {
        // World construction and room handshakes can take longer than the
        // visual arrival phase. Start it when the destination can draw.
        restartJumpArrival(entity);
    }
    newSystem.entities.set(uuid, entity);
    system = newSystem;
    resetGameplayClocks();
}

async function startGame(
    selection: StartMenuSelection,
) {
    await waitForCommunicatorUuid();
    world = new World();
    world.resources.set(GameDataResource, gameData);
    await world.addPlugin(multiplayer(multiRoom.join('main room')));
    mainRoomJoined = true;
    world.resources.set(MultiRoomResource, multiRoom);
    await world.addPlugin(NovaPlugin);

    // Make the player's ship
    const ids = await gameData.ids;
    const playerState = selection.playerState;
    const requestedShip = playerState.shipId;
    const shipId = ids.Ship.includes(requestedShip)
        ? requestedShip : 'nova:128';
    const shipData = await gameData.data.Ship.get(shipId);
    setCargoCapacity(playerState, shipData.cargoCapacity);
    const shipEntity = makeShip(shipData);
    const movement = shipEntity.components.get(MovementStateComponent);
    if (movement) {
        movement.position = new Position(...playerState.lastLandedPosition);
    }
    shipEntity.components.set(PlayerStateComponent, playerState);
    world.resources.set(PlayerStateResource, playerState);
    shipEntity.components.set(MultiplayerData, {
        owner: communicator.uuid!
    });
    shipEntity.components.set(PlayerShipSelector, undefined);
    const requestedSystem = playerState.currentSystem || 'nova:130';
    const systemId = ids.System.includes(requestedSystem)
        ? requestedSystem : 'nova:130';

    await transitionTo({
        entity: shipEntity,
        to: systemId,
        uuid: v4(),
    }, 'initial');
    stopTitleMusic();
    gameRunning = true;
    resumeGameplay();

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
        system?.emit(ResizeEvent, { x: window.innerWidth, y: window.innerHeight });
    }
    window.onresize = resize;

    if (!tickerInstalled) {
        const stats = new Stats();
        document.body.appendChild(stats.dom);
        app.ticker.add(() => {
            stats.begin();
            if (!gamePaused) {
                world?.step();
            }
            stats.end();
        });
        tickerInstalled = true;
    }
}

async function loadSnapshotSummaries() {
    try {
        const response = await fetch(
            `/player/snapshots?token=${encodeURIComponent(channel.playerToken)}`);
        if (!response.ok) {
            return [];
        }
        const raw = await response.json() as unknown;
        if (!Array.isArray(raw)) {
            return [];
        }
        return raw
            .map(value => PlayerSnapshotSummary.decode(value))
            .filter(isRight)
            .map(decoded => decoded.right);
    } catch {
        return [];
    }
}

async function restoreSnapshot(snapshotId: string): Promise<PlayerData | undefined> {
    const response = await fetch(
        `/player/snapshots/${encodeURIComponent(snapshotId)}/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: channel.playerToken }),
        });
    if (!response.ok) {
        return undefined;
    }
    const restored = await response.json() as Record<string, unknown>;
    const decoded = PlayerData.decode({
        uuid: communicator.uuid ?? 'client',
        system: restored.currentSystem,
        savedAt: restored.savedAt,
        playerState: restored,
    });
    return isRight(decoded) ? decoded.right : undefined;
}

async function showMainMenu(playerData: PlayerData | undefined) {
    escapeMenu.hide();
    startTitleMusicOnGesture();
    const menu = new StartMenu(gameData, {
        compatibilityProfile,
        controls: controlSettings,
    });
    const selection = await menu.show(playerData, restoreSnapshot);
    await startGame(selection);
}

async function returnToMainMenu(playerState?: PlayerState) {
    if (!gameRunning || mainMenuTransitioning) {
        return;
    }
    mainMenuTransitioning = true;
    gamePaused = true;
    gameRunning = false;
    try {
        const currentState = playerState
            ?? world?.resources.get(PlayerStateResource);
        const currentPlayerData = currentState
            ? {
                uuid: communicator.uuid ?? 'client',
                system: currentState.currentSystem,
                savedAt: Date.now(),
                playerState: currentState,
                snapshots: await loadSnapshotSummaries(),
            }
            : await playerDataPromise;
        await leaveGameWorld();
        if (mainRoomJoined) {
            multiRoom.leave('main room');
            mainRoomJoined = false;
        }
        await showMainMenu(currentPlayerData);
    } finally {
        mainMenuTransitioning = false;
    }
}

const escapeMenu = new EscapeMenu(
    resumeGameplay,
    returnToMainMenu,
);

window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !gameRunning) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (escapeMenu.visible) {
        escapeMenu.hide();
        resumeGameplay();
    } else {
        gamePaused = true;
        escapeMenu.show();
    }
}, true);

async function bootstrap() {
    [compatibilityProfile, controlSettings] = await Promise.all([
        loadCompatibilityProfile(),
        loadControlSettings(),
    ]);
    const initialPlayerData = await loadPersistedPlayerData()
        ?? await playerDataPromise;
    await showMainMenu(initialPlayerData);
}

void bootstrap().catch(error => {
    console.error('Failed to start NovaJS', error);
});




