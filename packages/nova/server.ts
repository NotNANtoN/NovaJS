import * as Comlink from 'comlink';
//import nodeEndpoint from "comlink/dist/esm/node-adapter";
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const nodeEndpoint = require("comlink/dist/umd/node-adapter.js");
import express from "express";
import { isLeft } from "fp-ts/Either";
import fs from "fs";
import http from "http";
import * as t from 'io-ts';
import { multiplayer, MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { World } from "nova_ecs/world";
import path from "path";
import { v4 } from "uuid";
import { Worker } from "worker_threads";
import { CommunicatorServer } from "./src/communication/CommunicatorServer.js";
import { MultiRoom } from './src/communication/multi_room_communicator.js';
import { SocketChannelServer } from "./src/communication/SocketChannelServer.js";
import { GameDataResource } from './src/nova_plugin/game_data_resource.js';
import { makeShip } from "./src/nova_plugin/make_ship.js";
import { MultiRoomResource, NovaPlugin } from './src/nova_plugin/nova_plugin.js';
import { ServerPlugin } from "./src/nova_plugin/server_plugin.js";
import { NovaRepl } from "./src/server/nova_repl.js";
import { FilesystemData } from "./src/server/parsing/FilesystemData.js";
import { GameDataAggregator } from "./src/server/parsing/GameDataAggregator.js";
import { NovaParseWorkerApi } from "./src/server/parsing/nova_parse_worker.js";
import { setupRoutes } from "./src/server/setupRoutes.js";
//import { NovaRepl } from "./src/server/NovaRepl.js";


const Settings = t.partial({
    port: t.number,
    relativeDataPath: t.string,
    https: t.boolean,
});
type Settings = t.TypeOf<typeof Settings>;

//const runfiles = require(process.env.BAZEL_NODE_RUNFILES_HELPER!) as { resolve: (path: string) => string };

const serverSettingsPath = path.join(__dirname, "../settings/server.json");
const maybeSettings = Settings.decode(
    JSON.parse(fs.readFileSync(serverSettingsPath, "utf8")) as unknown);

if (isLeft(maybeSettings)) {
    throw new Error('Failed to parse settings');
}

const settings = maybeSettings.right;
const port = settings.port ?? 8000;
const novaDataPath = path.join(__dirname, settings.relativeDataPath ?? "../Nova_Data");

const app = express();
const httpServer = http.createServer(app);

const filesystemDataPath = path.join(__dirname, "objects");
const filesystemData = new FilesystemData(filesystemDataPath);

const htmlPath = path.join(__dirname, "../src/index.html");
const bundlePath = path.join(__dirname, "src/browser_bundle.js");
const bundleMapPath = path.join(__dirname, "src/browser_bundle.js.map");
const clientSettingsPath = path.join(__dirname, "../settings/controls.json");


const channel = new SocketChannelServer({ server: httpServer });
const novaParseWorkerPath = path.join(__dirname, "src/server/parsing/nova_parse_worker_bundle.js");

let world: World;
let systemWorld: World;
const repl = new NovaRepl();

let communicator: CommunicatorServer;
async function startGame() {
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
    repl.repl.context.gameData = gameData;
    repl.repl.context.makeShip = makeShip;

    setupRoutes(gameData, app, htmlPath, bundlePath, bundleMapPath, clientSettingsPath);

    httpServer.listen(port, function () {
        console.log("listening at port " + port);
    });

    communicator = new CommunicatorServer(channel);
    const multiRoom = new MultiRoom(communicator);
    // TODO: Don't just give the server the 'server' uuid

    world = new World();
    world.resources.set(GameDataResource, gameData);
    await world.addPlugin(multiplayer(multiRoom.join('main room')));
    world.resources.set(MultiRoomResource, multiRoom);
    await world.addPlugin(NovaPlugin);

    repl.repl.context.world = world;

    await world.addPlugin(ServerPlugin);
    repl.repl.context.addEnemy = async (id?: string) => {
        const ids = await gameData.ids;
        id = id ?? ids.Ship[Math.floor(Math.random() * ids.Ship.length)];
        const randomShip = await gameData.data.Ship.get(id);
        const ship = makeShip(randomShip);
        ship.components.set(MultiplayerData, {
            owner: 'server',
        });
        //systemWorld.entities.set(v4(), ship);
        world.entities.set(v4(), ship);
    }

    stepper();
}

const STEP_TIME = 1000 / 60;
function stepper() {
    world.step();
    setTimeout(stepper, STEP_TIME);
}

startGame();

