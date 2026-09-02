import { AsyncSystemResource } from "nova_ecs/async_system";
import { Entity } from "nova_ecs/entity";
import { Comms, multiplayer, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import type { EncodedEntity } from "nova_ecs/plugins/serializer_plugin";
import { resetWallClock, TimeResource } from "nova_ecs/plugins/time_plugin";
import { World } from "nova_ecs/world";
import { isRight } from 'nova_ecs/either';
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
    outfitIdsFromState,
    warmFlightAssets,
} from "./display/flight_asset_warmup";
import {
    hideEnteringOverlay,
    showEnteringOverlay,
} from "./display/flight_load_overlay";
import { waitForFlightScene } from "./display/flight_scene_ready";
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
import { plainSnapshot } from 'nova_ecs/draft_snapshot';
import { WeaponEntries } from "./nova_plugin/fire_weapon_plugin";
import { makeShip } from "./nova_plugin/make_ship";
import { makeSystem } from "./nova_plugin/make_system";
import { MultiRoomResource, NovaPlugin, SystemComponent } from "./nova_plugin/nova_plugin";
import { OutfitsStateComponent } from "./nova_plugin/outfit_plugin";
import { PlayerShipSelector } from "./nova_plugin/player_ship_plugin";
import { CompatibilityProfile } from "./nova_plugin/entity_budget";
import {
    PlayerData,
    PlayerSnapshotSummary,
    PlayerState,
    PlayerStateComponent,
    PlayerStateResource,
    createInitialPlayerState,
    setCargoCapacity,
    decodePlayerState,
} from "./nova_plugin/player_state";
import {
    placeShipAtLanding,
    restoreStoredShip,
} from "./nova_plugin/restore_stored_ship";
import { SystemIdResource } from "./nova_plugin/system_id_resource";
import { ShipComponent } from "./nova_plugin/ship_plugin";
import {
    EscapeMenu,
    StartMenu,
    StartMenuSelection,
} from "./client/start_menu";

const INITIAL_PLAYER_STATE = createInitialPlayerState();
const gameData = new GameData();
(window as any).gameData = gameData;
(window as any).PIXI = PIXI;

const app = new PIXI.Application();

(window as any).app = app;
(window as any).novaTitleMusicState = getTitleMusicState;

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
// Tracked by uuid rather than by reference: a shipyard purchase replaces the
// entity under the same key, and the menu must carry the ship the pilot
// actually owns now.
let playerShipUuid: string | undefined;

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
type TransitionEntity = Entity | ((newSystem: World) => Entity);

async function transitionTo(
    { entity, to, uuid }: {
        entity: TransitionEntity,
        to: string,
        uuid: string,
    },
    cause: SystemTransitionCause,
) {
    if (system) {
        await leaveGameWorld();
    }

    const newSystem = makeSystem(to, gameData, undefined, compatibilityProfile);
    const transitionEntity = typeof entity === 'function'
        ? entity(newSystem) : entity;
    (window as any).novaDebug = new DebugSettings(newSystem, (window as any).novaDebug);

    (window as any).system = newSystem;
    newSystem.resources.set(PixiAppResource, app);
    await newSystem.addPlugin(Display);

    const newStage = newSystem.resources.get(Stage);
    if (!newStage) {
        throw new Error('World did not have Pixi Stage');
    }
    app.stage.addChild(newStage);
    // Reveal only once hulls and stellars have sprites. Otherwise Enter Ship
    // cuts to an empty starfield and things pop in one atlas later.
    newStage.visible = cause !== 'initial';

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
            // Buying a ship replaces the entity under this uuid, so the
            // captured one can be a hull the pilot no longer flies.
            const ship = newSystem.entities.get(uuid) ?? transitionEntity;
            const death = ship.components.get(PlayerDeathComponent);
            if (death?.outcome !== 'killed') {
                return;
            }
            void returnToMainMenu(plainSnapshot(
                ship.components.get(PlayerStateComponent)));
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
        restartJumpArrival(transitionEntity);
    }
    newSystem.entities.set(uuid, transitionEntity);
    system = newSystem;
    resetGameplayClocks();
    // Combat art loads in the background so the first shots still draw,
    // without holding the cockpit until every hull and weapon in the system
    // has a texture. The overlay only covers the player hull and planets.
    void warmFlightAssets({
        gameData,
        systemId: to,
        playerShipId: transitionEntity.components.get(ShipComponent)?.id,
        extraOutfitIds: outfitIdsFromState(
            transitionEntity.components.get(OutfitsStateComponent)),
        weaponEntries: newSystem.resources.get(WeaponEntries),
    });
    if (cause === 'initial') {
        const systemData = await gameData.data.System.get(to).catch(() => undefined);
        if (systemData?.name) {
            showEnteringOverlay(`Entering ${systemData.name}`);
        }
        await waitForFlightScene({
            step: () => world?.step(),
            afterStep: async () => {
                const pending = newSystem.resources.get(AsyncSystemResource);
                if (pending) {
                    await pending.done;
                }
            },
            entities: () => newSystem.entities,
            playerUuid: uuid,
            expectedPlanetCount: systemData?.planets.length ?? 0,
            snapshotRequested: () => Boolean(
                newSystem.singletonEntity.components.get(Comms)
                    ?.initialStateRequested),
        });
        resetGameplayClocks();
        newStage.visible = true;
    }
}

async function startGame(
    selection: StartMenuSelection,
) {
    showEnteringOverlay();
    try {
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
        ? requestedShip : INITIAL_PLAYER_STATE.shipId;
    const shipData = await gameData.data.Ship.get(shipId);
    setCargoCapacity(playerState, shipData.cargoCapacity);
    world.resources.set(PlayerStateResource, playerState);
    const preparePlayerShip = (newSystem: World) => {
        const fallback = makeShip(shipData);
        const serializer = newSystem.resources.get(SerializerResource);
        const result = serializer
            ? restoreStoredShip(
                serializer, selection.ship, fallback, shipId)
            : {
                entity: fallback,
                restored: false,
                skippedComponents: [],
                fallbackReason: selection.ship === undefined
                    ? undefined : 'invalid-entity' as const,
            };
        if (result.skippedComponents.length > 0) {
            console.warn(`Skipped stored ship components: ${
                result.skippedComponents.join(', ')}`);
        }
        if (selection.ship !== undefined && !result.restored) {
            console.warn('Stored ship was unusable; using a fresh hull');
        }
        const shipEntity = result.entity;
        placeShipAtLanding(shipEntity, playerState.lastLandedPosition);
        shipEntity.components.set(PlayerStateComponent, playerState);
        shipEntity.components.set(MultiplayerData, {
            owner: communicator.uuid!,
        });
        shipEntity.components.set(PlayerShipSelector, undefined);
        return shipEntity;
    };
    const requestedSystem = playerState.currentSystem
        || INITIAL_PLAYER_STATE.currentSystem;
    const systemId = ids.System.includes(requestedSystem)
        ? requestedSystem : INITIAL_PLAYER_STATE.currentSystem;

    playerShipUuid = v4();
    await transitionTo({
        entity: preparePlayerShip,
        to: systemId,
        uuid: playerShipUuid,
    }, 'initial');
    stopTitleMusic();
    gameRunning = true;
    resumeGameplay();
    } finally {
        hideEnteringOverlay();
    }

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

async function loadSnapshotSummaries(): Promise<PlayerSnapshotSummary[]> {
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

async function archivePilotSnapshot(request: {
    state: PlayerState;
    ship?: EncodedEntity;
    replaceCurrent?: PlayerState;
    replaceShip?: EncodedEntity;
}): Promise<PlayerSnapshotSummary[] | undefined> {
    try {
        const response = await fetch('/player/snapshots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: channel.playerToken,
                state: plainSnapshot(request.state),
                ...(request.ship === undefined
                    ? {}
                    : { ship: request.ship }),
                ...(request.replaceCurrent === undefined
                    ? {}
                    : { replaceCurrent: plainSnapshot(request.replaceCurrent) }),
                ...(request.replaceShip === undefined
                    ? {}
                    : { replaceShip: request.replaceShip }),
                reason: 'manual',
            }),
        });
        if (!response.ok) {
            return undefined;
        }
        const raw = await response.json() as unknown;
        if (!Array.isArray(raw)) {
            return undefined;
        }
        return raw
            .map(value => PlayerSnapshotSummary.decode(value))
            .filter(isRight)
            .map(decoded => decoded.right);
    } catch {
        return undefined;
    }
}

async function archiveDeathPilotIfNeeded(
    state: PlayerState,
    ship?: EncodedEntity,
): Promise<PlayerSnapshotSummary[] | undefined> {
    if (state.diedAt === undefined) {
        return undefined;
    }
    const existing = await loadSnapshotSummaries();
    const alreadyArchived = existing.some(snapshot =>
        snapshot.diedAt === state.diedAt
        && snapshot.pilotName === state.pilotName);
    if (alreadyArchived) {
        return existing;
    }
    return archivePilotSnapshot({ state, ship });
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
    const decoded = PlayerData.decode(await response.json() as unknown);
    return isRight(decoded) ? decoded.right : undefined;
}

async function showMainMenu(playerData: PlayerData | undefined) {
    escapeMenu.hide();
    startTitleMusicOnGesture();
    const menu = new StartMenu(gameData, {
        compatibilityProfile,
        controls: controlSettings,
    });
    const selection = await menu.show(
        playerData,
        restoreSnapshot,
        loadSnapshotSummaries,
        archivePilotSnapshot,
    );
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
        // Leaving the world steps it once more, which revokes any component
        // draft the caller read this out of. The menu reads it afterwards.
        // JSON-detach through the persistence codec so nested arrays cannot
        // remain draft proxies that throw on the death notice.
        const raw = plainSnapshot(playerState
            ?? world?.resources.get(PlayerStateResource));
        const decoded = raw ? decodePlayerState(raw) : undefined;
        const currentState = decoded && isRight(decoded)
            ? decoded.right
            : raw;
        const serializer = system?.resources.get(SerializerResource);
        let currentShip;
        try {
            const liveShip = playerShipUuid
                ? system?.entities.get(playerShipUuid) : undefined;
            currentShip = serializer && liveShip
                ? serializer.encode(liveShip) : undefined;
        } catch (error) {
            console.warn('Could not retain the current ship for the menu', error);
        }
        const currentPlayerData = currentState
            ? {
                uuid: communicator.uuid ?? 'client',
                system: currentState.currentSystem,
                savedAt: Date.now(),
                playerState: currentState,
                snapshots: await archiveDeathPilotIfNeeded(
                    currentState, currentShip)
                    ?? await loadSnapshotSummaries(),
                ...(currentShip === undefined ? {} : { ship: currentShip }),
            }
            : await playerDataPromise;
        await leaveGameWorld();
        playerShipUuid = undefined;
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
    const pixelRatio = window.devicePixelRatio || 1;
    PIXI.TextureStyle.defaultOptions.scaleMode = 'linear';
    await app.init({
        width: window.innerWidth,
        height: window.innerHeight,
        resolution: pixelRatio,
        autoDensity: true,
        preserveDrawingBuffer: true,
        preference: 'webgpu',
    });
    document.body.appendChild(app.canvas);
    startTitleMusicOnGesture();

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




