import * as express from "express";
import { Express } from "express";
import * as path from 'path';
import { gzip } from "zlib";
import { idsPath, dataPath, settingsPrefix } from "../common/GameDataPaths";
import { GameDataInterface } from "../../../novadatainterface/GameDataInterface";
import { NovaDataType } from "../../../novadatainterface/NovaDataInterface";


/**
 * Serves GameData to the client
 * Maybe consider https://github.com/RioloGiuseppe/byte-serializer in the future?
 */
export function setupRoutes(gameData: GameDataInterface, app: Express, htmlPath: string, bundlePath: string, bundleMapPath: string, settingsPath: string) {
    return new GameDataServer(gameData, app, htmlPath, bundlePath, bundleMapPath, settingsPath);
}

function gzipMiddleware(req: express.Request, res: express.Response,
    next: express.NextFunction) {
    const acceptedEncoding = req.headers['accept-encoding'];
    if (typeof acceptedEncoding !== 'string'
        || !/\bgzip\b/i.test(acceptedEncoding)
        || /\.(?:png|mp3)(?:$|\?)/i.test(req.path)) {
        next();
        return;
    }

    const chunks: Buffer[] = [];
    const append = (chunk: any, encoding?: BufferEncoding) => {
        if (chunk !== undefined && chunk !== null) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        }
    };
    const originalEnd = res.end.bind(res);

    res.write = ((chunk: any, encoding?: any, callback?: any) => {
        const writeCallback = typeof encoding === 'function' ? encoding : callback;
        append(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined);
        if (typeof writeCallback === 'function') {
            writeCallback();
        }
        return true;
    }) as typeof res.write;
    res.end = ((chunk?: any, encoding?: any, callback?: any) => {
        let endCallback = callback;
        if (typeof chunk === 'function') {
            endCallback = chunk;
            chunk = undefined;
        } else if (typeof encoding === 'function') {
            endCallback = encoding;
        }
        append(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined);

        const body = Buffer.concat(chunks);
        const contentType = String(res.getHeader('Content-Type') ?? '');
        const compressible = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/
            .test(contentType);
        if (!compressible || body.length === 0
            || res.getHeader('Content-Encoding')) {
            (originalEnd as any)(body, endCallback);
            return res;
        }

        gzip(body, (error, compressed) => {
            if (error) {
                (originalEnd as any)(body, endCallback);
                return;
            }
            res.setHeader('Content-Encoding', 'gzip');
            res.vary('Accept-Encoding');
            res.removeHeader('Content-Length');
            (originalEnd as any)(compressed, endCallback);
        });
        return res;
    }) as typeof res.end;

    next();
}

// This is a helper class used by `setupRoutes`
class GameDataServer {
    constructor(
        private readonly gameData: GameDataInterface,
        private readonly app: Express,
        private readonly htmlPath: string,
        private readonly bundlePath: string,
        private readonly bundleMapPath: string,
        private readonly settingsPath: string) {
        this.setupRoutes();
    }

    private setupRoutes() {
        // The order in which these routes are set up matters.
        // Earlier routes take precedence over later ones.
        // NOTE: This can not be converted to RPCs because PIXI.js
        // expects assets to be loaded from URLs.

        this.app.use(gzipMiddleware);
        this.app.use(dataPath, (_req, res, next) => {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            next();
        });

        this.app.get(path.join(dataPath, ":name/:item.png"), this.requestFulfiller.bind(this));
        this.app.get(path.join(dataPath, ":name/:item.json"), this.requestFulfiller.bind(this));
        this.app.get(path.join(dataPath, ":name/:item.mp3"), this.requestFulfiller.bind(this));
        this.app.get(path.join(dataPath, ":name/:item"), this.requestFulfiller.bind(this));
        this.app.get(idsPath + ".json", this.idRequestFulfiller.bind(this));

        this.app.use('/preloadData.json', async (_req, res) => {
            res.send(this.gameData.preloadData ? await this.gameData.preloadData : {});
        });

        this.app.use(settingsPrefix,
            express.static(this.settingsPath));

        //        // This has to be here or else sourcemaps don't work!
        //        const staticPath = path.join(this.appRoot, "build", "static");
        //        this.app.use("/static", express.static(staticPath));
        this.app.use("/settings/controls.json", (_req: express.Request, res: express.Response) => {
            res.sendFile(this.settingsPath);
        });

        this.app.use("/browser_bundle.js", (_req: express.Request, res: express.Response) => {
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(this.bundlePath);
        });

        this.app.use("/browser_bundle.js.map", (_req: express.Request, res: express.Response) => {
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(this.bundleMapPath);
        });

        this.app.use("/", (_req: express.Request, res: express.Response) => {
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(this.htmlPath);
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
                res.send(Buffer.from(data));
            }
            else {
                res.send(data);
            }
        }
        else {
            res.send("Unknown data type " + name);
        }
    }

    private async idRequestFulfiller(_req: express.Request, res: express.Response): Promise<void> {
        res.send(await this.gameData.ids);
    }
}
