import * as express from "express";
import { Express } from "express";
import fs from 'fs';
import * as path from 'path';
import { gzip } from "zlib";
import { idsPath, dataPath, settingsPrefix } from "../common/GameDataPaths";
import { GameDataInterface } from "../../../novadatainterface/GameDataInterface";
import { NovaDataType } from "../../../novadatainterface/NovaDataInterface";
import { PlayerStore } from "./player_store";
import { setupHttpLimiter } from './http_limiter';
import { LosslessWebPCache } from './lossless_webp';
import {
    makePlayerData,
    summarizeSnapshot,
} from '../nova_plugin/player_data_projection';

export const IMMUTABLE_ASSET_CACHE =
    'public, max-age=31536000, immutable';
export const REVALIDATE_METADATA_CACHE = 'no-cache';

export function gameDataCacheControl(requestPath: string): string {
    return /\.(?:png|webp|mp3)$/i.test(requestPath)
        ? IMMUTABLE_ASSET_CACHE
        : REVALIDATE_METADATA_CACHE;
}

/**
 * Serves GameData to the client
 * Maybe consider https://github.com/RioloGiuseppe/byte-serializer in the future?
 */
export function setupRoutes(gameData: GameDataInterface, app: Express, htmlPath: string, bundlePath: string, bundleMapPath: string, settingsPath: string, novaDataPath?: string, playerStore?: PlayerStore) {
    return new GameDataServer(gameData, app, htmlPath, bundlePath, bundleMapPath, settingsPath, novaDataPath, playerStore);
}

function gzipMiddleware(req: express.Request, res: express.Response,
    next: express.NextFunction) {
    const acceptedEncoding = req.headers['accept-encoding'];
    if (typeof acceptedEncoding !== 'string'
        || !/\bgzip\b/i.test(acceptedEncoding)
        || /\.(?:png|webp|mp3)(?:$|\?)/i.test(req.path)) {
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
    private readonly losslessWebP = new LosslessWebPCache();

    constructor(
        private readonly gameData: GameDataInterface,
        private readonly app: Express,
        private readonly htmlPath: string,
        private readonly bundlePath: string,
        private readonly bundleMapPath: string,
        private readonly settingsPath: string,
        private readonly novaDataPath?: string,
        private readonly playerStore?: PlayerStore) {
        this.setupRoutes();
    }

    private setupRoutes() {
        // The order in which these routes are set up matters.
        // Earlier routes take precedence over later ones.
        // NOTE: This can not be converted to RPCs because PIXI.js
        // expects assets to be loaded from URLs.

        setupHttpLimiter(this.app);
        this.app.use(gzipMiddleware);
        this.app.use(dataPath, (req, res, next) => {
            res.setHeader('Cache-Control', gameDataCacheControl(req.path));
            next();
        });

        this.app.get(path.join(dataPath, ":name/:item.png"), this.requestFulfiller.bind(this));
        this.app.get(path.join(dataPath, ":name/:item.webp"),
            this.requestFulfiller.bind(this));
        this.app.get(path.join(dataPath, ":name/:item.json"), this.requestFulfiller.bind(this));
        this.app.get(path.join(dataPath, ":name/:item.mp3"), this.requestFulfiller.bind(this));
        this.app.get(path.join(dataPath, ":name/:item"), this.requestFulfiller.bind(this));
        this.app.get(idsPath + ".json", (_req, res, next) => {
            res.setHeader('Cache-Control', REVALIDATE_METADATA_CACHE);
            next();
        }, this.idRequestFulfiller.bind(this));

        if (this.novaDataPath) {
            this.app.get("/music/Nova%20Music.mp3", (_req, res) => {
                res.setHeader('Cache-Control', IMMUTABLE_ASSET_CACHE);
                res.sendFile(path.join(this.novaDataPath!, "Nova Files",
                    "Nova Music.mp3"));
            });
        }

        this.app.use('/preloadData.json', async (_req, res) => {
            res.setHeader('Cache-Control', REVALIDATE_METADATA_CACHE);
            res.send(this.gameData.preloadData ? await this.gameData.preloadData : {});
        });

        this.app.use(settingsPrefix, (_req, res, next) => {
            res.setHeader('Cache-Control', REVALIDATE_METADATA_CACHE);
            next();
        },
            express.static(path.dirname(this.settingsPath)));

        if (this.playerStore) {
            this.app.use(express.json({ limit: '10mb' }));
            this.app.get('/player/state', async (req, res) => {
                const token = typeof req.query.token === 'string'
                    ? req.query.token : undefined;
                if (!token) {
                    res.status(400).send('Missing player token');
                    return;
                }
                const [player, quarantine] = await Promise.all([
                    this.playerStore!.get(token),
                    this.playerStore!.quarantine?.(token)
                        ?? Promise.resolve('none' as const),
                ]);
                if (!player && quarantine === 'none') {
                    res.status(404).send('Player not found');
                    return;
                }
                res.send(makePlayerData('persisted', {
                    ...(player === undefined ? {} : {
                        state: player,
                        savedAt: player.savedAt,
                        ship: player.ship,
                        snapshots: player.snapshots,
                    }),
                    quarantine,
                }));
            });
            this.app.get('/player/snapshots', async (req, res) => {
                const token = typeof req.query.token === 'string'
                    ? req.query.token : undefined;
                if (!token) {
                    res.status(400).send('Missing player token');
                    return;
                }
                const snapshots = await this.playerStore!.getSnapshots(token);
                res.send(snapshots.map(summarizeSnapshot));
            });
            this.app.post('/player/snapshots', async (req, res) => {
                const token = typeof req.body?.token === 'string'
                    ? req.body.token : undefined;
                if (!token) {
                    res.status(400).send('Missing player token');
                    return;
                }
                const state = req.body?.state;
                if (!state || typeof state !== 'object') {
                    res.status(400).send('Missing pilot state');
                    return;
                }
                const reason = req.body?.reason === 'landing'
                    || req.body?.reason === 'manual'
                    ? req.body.reason
                    : 'manual';
                const ship = req.body?.ship;
                const encodedShip = ship && typeof ship === 'object'
                    ? ship
                    : undefined;
                try {
                    await this.playerStore!.archiveSnapshot(
                        token,
                        state,
                        encodedShip,
                        reason,
                    );
                } catch (error) {
                    console.error('Pilot archive failed', error);
                    res.status(500).send('Pilot archive failed');
                    return;
                }
                const replaceCurrent = req.body?.replaceCurrent;
                if (replaceCurrent && typeof replaceCurrent === 'object') {
                    const replaceShip = req.body?.replaceShip;
                    const encodedReplaceShip = replaceShip
                        && typeof replaceShip === 'object'
                        ? replaceShip
                        : undefined;
                    try {
                        await this.playerStore!.save(
                            token,
                            replaceCurrent,
                            encodedReplaceShip,
                        );
                    } catch (error) {
                        console.error('Pilot switch save failed', error);
                        res.status(500).send('Pilot switch save failed');
                        return;
                    }
                }
                const snapshots = await this.playerStore!.getSnapshots(token);
                res.send(snapshots.map(summarizeSnapshot));
            });
            this.app.post('/player/snapshots/:snapshotId/restore',
                async (req, res) => {
                    const token = typeof req.body?.token === 'string'
                        ? req.body.token : undefined;
                    if (!token) {
                        res.status(400).send('Missing player token');
                        return;
                    }
                    const player = await this.playerStore!.restoreSnapshot(
                        token, req.params.snapshotId);
                    if (!player) {
                        res.status(404).send('Snapshot not found');
                        return;
                    }
                    res.send(makePlayerData('persisted', {
                        state: player,
                        savedAt: player.savedAt,
                        ship: player.ship,
                        snapshots: player.snapshots,
                    }));
                });
            this.app.get('/api/galaxy/pilots', async (_req, res) => {
                try {
                    const list = await this.playerStore!.getAllPilotsSummary?.() ?? [];
                    res.json(list);
                } catch (error) {
                    console.error('Failed to get pilot directory', error);
                    res.status(500).send('Failed to get pilot directory');
                }
            });
        }

        //        // This has to be here or else sourcemaps don't work!
        //        const staticPath = path.join(this.appRoot, "build", "static");
        //        this.app.use("/static", express.static(staticPath));
        this.app.use("/settings/controls.json", (_req: express.Request, res: express.Response) => {
            res.setHeader('Cache-Control', REVALIDATE_METADATA_CACHE);
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
            let html = fs.readFileSync(this.htmlPath, 'utf8');
            const bundleVersion = Math.floor(
                fs.statSync(this.bundlePath).mtimeMs);
            html = html.replace(
                'browser_bundle.js',
                `browser_bundle.js?v=${bundleVersion}`);
            res.type('html').send(html);
        });
    }

    private async requestFulfiller(req: express.Request, res: express.Response): Promise<void> {
        const name: string = req.params.name;
        const item: string = req.params.item;
        const wantsWebP = /\.webp$/i.test(req.path);

        // TODO: Replace with protobufs
        var dataGettable = this.gameData.data[name as NovaDataType];

        if (dataGettable) {
            let data = await dataGettable.get(item);
            if (data instanceof ArrayBuffer) {
                const buffer = Buffer.from(data);
                if (wantsWebP) {
                    const webP = await this.losslessWebP.get(
                        `${name}\0${item}`,
                        buffer,
                    );
                    res.type('webp').send(webP);
                } else {
                    res.type('png').send(buffer);
                }
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
