import * as Comlink from 'comlink';
//import nodeEndpoint from "comlink/dist/esm/node-adapter";
import nodeEndpoint from "comlink/dist/umd/node-adapter";
import express from "express";
import { isLeft } from 'nova_ecs/either';
import fs from "fs";
import http from "http";
import * as t from 'io-ts';
import { multiplayer, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { World } from "nova_ecs/world";
import path from "path";
import { v4 } from "uuid";
import { Worker } from "worker_threads";
import { CommunicatorServer } from "./src/communication/CommunicatorServer";
import { MultiRoom } from './src/communication/multi_room_communicator';
import { SocketChannelServer } from "./src/communication/SocketChannelServer";
import { GameDataResource } from './src/nova_plugin/game_data_resource';
import { makeShip } from "./src/nova_plugin/make_ship";
import { MultiRoomResource, NovaPlugin, SystemComponent } from './src/nova_plugin/nova_plugin';
import { PlayerStoreResource } from './src/nova_plugin/player_state';
import { ServerPlugin } from "./src/nova_plugin/server_plugin";
import { NovaRepl } from "./src/server/nova_repl";
import { FilesystemData } from "./src/server/parsing/FilesystemData";
import { GameDataAggregator } from "./src/server/parsing/GameDataAggregator";
import { NovaParseWorkerApi } from "./src/server/parsing/nova_parse_worker";
import { setupRoutes } from "./src/server/setupRoutes";
import { PlayerStore } from './src/server/player_store';
import {
    CompatibilityProfile,
    CompatibilityProfileResource,
} from './src/nova_plugin/entity_budget';
//import { NovaRepl } from "./src/server/NovaRepl";


const Settings = t.partial({
    port: t.number,
    relativeDataPath: t.string,
    https: t.boolean,
    compatibilityProfile: t.union([
        t.literal('classic'),
        t.literal('modern'),
    ]),
});
type Settings = t.TypeOf<typeof Settings>;

const projectRoot = path.resolve(__dirname, "..");
const sourceRoot = path.join(projectRoot, "nova");
const resolveAsset = (sourcePath: string): string => path.join(projectRoot, sourcePath);

const serverSettingsPath = resolveAsset("nova/settings/server.json");
const maybeSettings = Settings.decode(
    JSON.parse(fs.readFileSync(serverSettingsPath, "utf8")) as unknown);

if (isLeft(maybeSettings)) {
    throw new Error('Failed to parse settings');
}

const settings = maybeSettings.right;
const compatibilityProfile: CompatibilityProfile =
    settings.compatibilityProfile ?? 'modern';
const port = Number(process.env.NOVA_PORT ?? settings.port ?? 8000);
const novaDataPath = path.join(sourceRoot, settings.relativeDataPath ?? "Nova_Data");

const app = express();
const httpServer = http.createServer(app);

const filesystemDataPath = path.join(sourceRoot, "objects");
const filesystemData = new FilesystemData(filesystemDataPath);

const htmlPath = resolveAsset("nova/src/index.html");
const bundlePath = resolveAsset("dist/browser_bundle.js");
const bundleMapPath = resolveAsset("dist/browser_bundle.js.map");
const clientSettingsPath = resolveAsset("nova/settings/controls.json");


const channel = new SocketChannelServer({ server: httpServer });
const novaParseWorkerPath = resolveAsset("dist/nova_parse_worker.js");

let world: World;
const repl = new NovaRepl();
const playerStore = new PlayerStore();

const SHUTDOWN_TIMEOUT_MS = 5_000;
let shuttingDown = false;

async function shutdown(signal: 'SIGINT' | 'SIGTERM') {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    const exitCode = signal === 'SIGINT' ? 130 : 143;
    let timeout: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            playerStore.flush(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error('Timed out flushing player data'));
                }, SHUTDOWN_TIMEOUT_MS);
            }),
        ]);
    } catch (error) {
        console.error(`Failed to flush player data during ${signal}`, error);
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
        process.exit(exitCode);
    }
}

process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
    void shutdown('SIGINT');
});

let communicator: CommunicatorServer;
async function startGame() {
    // This also creates the default data file before asset parsing starts.
    await playerStore.ready;
    // Set up the novaparse webworker
    const novaParseWorker = new Worker(novaParseWorkerPath);
    const novaParseWorkerApi = Comlink.wrap<NovaParseWorkerApi>(
        nodeEndpoint(novaParseWorker));

    await novaParseWorkerApi.init(novaDataPath);
    const novaFileData = await novaParseWorkerApi.novaParse;
    //const novaFileData = new NovaParse(novaDataPath, false);
    if (!novaFileData) {
        throw new Error("Expected novaparse worker to be defined");
    }
    const gameData = new GameDataAggregator([filesystemData, novaFileData]);
    if (repl.repl) {
        repl.repl.context.gameData = gameData;
        repl.repl.context.makeShip = makeShip;
    }

    setupRoutes(gameData, app, htmlPath, bundlePath, bundleMapPath,
        clientSettingsPath, novaDataPath, playerStore);

    httpServer.listen(port, function() {
        console.log("listening at port " + port);
    });

    communicator = new CommunicatorServer(channel);
    const multiRoom = new MultiRoom(communicator);
    // TODO: Don't just give the server the 'server' uuid

    world = new World();
    world.resources.set(GameDataResource, gameData);
    world.resources.set(PlayerStoreResource, playerStore);
    world.resources.set(CompatibilityProfileResource, compatibilityProfile);
    await world.addPlugin(multiplayer(multiRoom.join('main room')));
    world.resources.set(MultiRoomResource, multiRoom);
    await world.addPlugin(NovaPlugin);

    if (repl.repl) {
        repl.repl.context.world = world;
    }

    await world.addPlugin(ServerPlugin);
    if (repl.repl) {
        repl.repl.context.addEnemy = async (id?: string) => {
            // System worlds are created lazily by ServerPlugin and stored as
            // SystemComponent on entities of the root world.
            let systemWorld: World | undefined;
            for (const entity of world.entities.values()) {
                systemWorld = entity.components.get(SystemComponent);
                if (systemWorld) {
                    break;
                }
            }
            if (!systemWorld) {
                console.log('No active system world yet. '
                    + 'A client must connect before enemies can be added.');
                return;
            }
            const ids = await gameData.ids;
            id = id ?? ids.Ship[Math.floor(Math.random() * ids.Ship.length)];
            const randomShip = await gameData.data.Ship.get(id);
            const ship = makeShip(randomShip);
            ship.components.set(MultiplayerData, {
                owner: 'server',
            });
            systemWorld.entities.set(v4(), ship);
        };
    }

    stepper();
}

const STEP_TIME = 1000 / 60;
// Fixed-timestep loop: schedules relative to when each step *should* have
// run, so simulation frequency stays at 60Hz under load (bounded catch-up)
// instead of drifting by the duration of every step.
const MAX_CATCH_UP_STEPS = 5;
let nextStepTime: number | undefined;
function stepper() {
    const now = performance.timeOrigin + performance.now();
    nextStepTime = nextStepTime ?? now;

    let steps = 0;
    while (nextStepTime <= now && steps < MAX_CATCH_UP_STEPS) {
        world.step();
        nextStepTime += STEP_TIME;
        steps++;
    }
    if (nextStepTime <= now) {
        // Too far behind; drop the backlog rather than spiraling.
        nextStepTime = now + STEP_TIME;
    }
    setTimeout(stepper, Math.max(0, nextStepTime - (performance.timeOrigin + performance.now())));
}

startGame();

