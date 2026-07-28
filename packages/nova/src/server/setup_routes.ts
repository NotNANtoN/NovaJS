import * as express from "express";
import { Express } from "express";
import * as path from 'path';
import { idsPath, dataPath, batchPath, settingsPrefix } from "../common/game_data_paths.js";
import { GameDataInterface } from "novadatainterface/game_data_interface";
import { NovaDataType } from "novadatainterface/nova_data_interface";

/**
 * Request body for the batch endpoint: a map from data type to the
 * list of ids requested for that type.
 */
export type BatchRequest = { [dataType: string]: string[] };

/**
 * Response from the batch endpoint. For each requested (type, id), the
 * entry is either `{ data }` on success or `{ error }` if that single
 * id could not be resolved. A missing id must NOT fail the whole
 * batch, so errors are reported per-id rather than as a non-200 status.
 */
export type BatchResponseEntry<T = unknown> = { data: T } | { error: string };
export type BatchResponse = {
    [dataType: string]: { [id: string]: BatchResponseEntry }
};

/**
 * Resolves every (dataType, id) in `body` against `gameData`, returning
 * a per-id success/error map. Pure and transport-agnostic so it can be
 * unit tested without an HTTP server.
 *
 * Contract:
 *  - An unknown data type marks each of its ids with an error entry.
 *  - A per-id load rejection becomes that id's error entry; it never
 *    fails sibling ids or other types.
 *  - Binary (ArrayBuffer) results are rejected as errors: the batch
 *    endpoint carries only JSON metadata; binaries keep their
 *    per-resource routes.
 */
export async function resolveBatch(
    gameData: GameDataInterface,
    body: BatchRequest,
): Promise<BatchResponse> {
    const result: BatchResponse = {};
    await Promise.all(Object.entries(body).map(async ([name, ids]) => {
        const typeResult: { [id: string]: BatchResponseEntry } = {};
        result[name] = typeResult;

        const dataGettable = gameData.data[name as NovaDataType];
        if (!dataGettable) {
            for (const id of ids ?? []) {
                typeResult[id] = { error: 'Unknown data type ' + name };
            }
            return;
        }
        if (!Array.isArray(ids)) {
            return;
        }

        // Resolve every id concurrently; one rejection only affects its
        // own entry.
        await Promise.all(ids.map(async (id) => {
            try {
                const data = await dataGettable.get(id);
                if (data instanceof ArrayBuffer) {
                    typeResult[id] = { error: 'Binary data is not available over the batch endpoint' };
                    return;
                }
                typeResult[id] = { data };
            } catch (e) {
                typeResult[id] = { error: e instanceof Error ? e.message : String(e) };
            }
        }));
    }));
    return result;
}


/**
 * Serves GameData to the client
 * Maybe consider https://github.com/RioloGiuseppe/byte-serializer in the future?
 */
export function setupRoutes(
    gameData: GameDataInterface,
    app: Express,
    htmlPath: string,
    bundlePath: string,
    bundleMapPath: string,
    simulationWorkerBundlePath: string,
    simulationWorkerBundleMapPath: string,
    settingsDir: string,
) {
    return new GameDataServer(
        gameData,
        app,
        htmlPath,
        bundlePath,
        bundleMapPath,
        simulationWorkerBundlePath,
        simulationWorkerBundleMapPath,
        settingsDir,
    );
}

// This is a helper class used by `setupRoutes`
class GameDataServer {
    constructor(
        private readonly gameData: GameDataInterface,
        private readonly app: Express,
        private readonly htmlPath: string,
        private readonly bundlePath: string,
        private readonly bundleMapPath: string,
        private readonly simulationWorkerBundlePath: string,
        private readonly simulationWorkerBundleMapPath: string,
        private readonly settingsDir: string) {
        this.setupRoutes();
    }

    private setupRoutes() {
        // The order in which these routes are set up matters.
        // Earlier routes take precedence over later ones.
        // NOTE: This can not be converted to RPCs because PIXI.js
        // expects assets to be loaded from URLs.

        // The batch route must be registered before the generic
        // `:name/:item` routes below, or `/data/batch` would be parsed
        // as `name=batch`. It coalesces many per-id metadata fetches
        // into one round trip; the per-resource routes remain for other
        // consumers (PIXI asset loads, node tooling, direct fetches).
        this.app.post(batchPath,
            express.json({ limit: '2mb' }),
            this.batchRequestFulfiller.bind(this));

        this.app.get(path.join(dataPath, ":name/:item.png"), this.requestFulfiller.bind(this));
        this.app.get(path.join(dataPath, ":name/:item.json"), this.requestFulfiller.bind(this));
        this.app.get(path.join(dataPath, ":name/:item.mp3"), this.requestFulfiller.bind(this));
        this.app.get(path.join(dataPath, ":name/:item"), this.requestFulfiller.bind(this));
        this.app.get(idsPath + ".json", this.idRequestFulfiller.bind(this));

        this.app.use('/preloadData.json', async (_req, res) => {
            res.send(this.gameData.preloadData ? await this.gameData.preloadData : {});
        });

        // Serves every client settings file in the settings directory
        // (controls.json, settings.json, ...).
        this.app.use(settingsPrefix,
            express.static(this.settingsDir));

        //        // This has to be here or else sourcemaps don't work!
        //        const staticPath = path.join(this.appRoot, "build", "static");
        //        this.app.use("/static", express.static(staticPath));

        // no-cache = revalidate every load (a 304 keeps it fast).
        // Without it, browsers cache heuristically for hours and a
        // STALE CLIENT BUILD joins a new server: it desyncs no matter
        // how healthy the netcode is, uploads no dumps, and reads as
        // an unsolvable netcode mystery (the 2026-07-26 session).
        const noCache = (res: express.Response) =>
            res.set('Cache-Control', 'no-cache');

        this.app.use("/browser_bundle.js", (_req: express.Request, res: express.Response) => {
            noCache(res).sendFile(this.bundlePath);
        });

        this.app.use("/browser_bundle.js.map", (_req: express.Request, res: express.Response) => {
            noCache(res).sendFile(this.bundleMapPath);
        });

        this.app.use("/simulation_bridge_browser_worker_bundle.js", (_req: express.Request, res: express.Response) => {
            noCache(res).sendFile(this.simulationWorkerBundlePath);
        });

        this.app.use("/simulation_bridge_browser_worker_bundle.js.map", (_req: express.Request, res: express.Response) => {
            noCache(res).sendFile(this.simulationWorkerBundleMapPath);
        });

        this.app.use("/", (_req: express.Request, res: express.Response) => {
            noCache(res).sendFile(this.htmlPath);
        });
    }

    private async requestFulfiller(req: express.Request, res: express.Response): Promise<void> {
        const name: string = req.params.name;
        const item: string = req.params.item;

        // TODO: Replace with protobufs
        var dataGettable = this.gameData.data[name as NovaDataType];

        if (dataGettable) {
            let data = await dataGettable.get(item);
            if (data instanceof ArrayBuffer) {
                data = Buffer.from(data) as unknown as ArrayBuffer;
            }
            res.send(data);
        }
        else {
            res.send("Unknown data type " + name);
        }
    }

    /**
     * Resolves many (dataType, id) pairs in one request. The body is a
     * BatchRequest ({ [dataType]: id[] }); the response is a
     * BatchResponse ({ [dataType]: { [id]: { data } | { error } } }).
     *
     * A missing id, an unknown data type, or a per-id load failure is
     * reported in that id's entry and never fails the whole batch. Only
     * a malformed request body (not an object) yields a 400.
     */
    private async batchRequestFulfiller(req: express.Request, res: express.Response): Promise<void> {
        const body = req.body as BatchRequest | undefined;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            res.status(400).send({ error: 'Batch request body must be a { dataType: id[] } object' });
            return;
        }
        res.send(await resolveBatch(this.gameData, body));
    }

    private async idRequestFulfiller(_req: express.Request, res: express.Response): Promise<void> {
        res.send(await this.gameData.ids);
    }
}
