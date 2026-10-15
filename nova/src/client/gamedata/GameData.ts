import { getCachedPayload, setCachedPayload } from './idb_cache';
function joinPath(...parts: string[]): string {
    const isAbsolute = Boolean(parts[0]?.startsWith("/"));
    const joined = parts.map(p => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
    return isAbsolute ? "/" + joined : joined;
}
import { BaseData } from 'novadatainterface/BaseData';
import { GameDataInterface, PreloadData } from 'novadatainterface/GameDataInterface';
import { Gettable } from 'novadatainterface/Gettable';
import {
    ALL_NOVA_DATA_TYPES,
    NOVA_DATA_REGISTRY,
    NovaDataInterfaceWithMission,
    NovaDataType,
} from 'novadatainterface/NovaDataInterface';
import { NovaIDs } from 'novadatainterface/NovaIDs';
import { PictImageData } from 'novadatainterface/PictImage';
import { SoundFile } from 'novadatainterface/SoundFile';
import { SpriteSheetFramesData } from 'novadatainterface/SpriteSheetData';
import { WeaponData } from 'novadatainterface/WeaponData';
import * as PIXI from 'pixi.js';
import * as sound from '@pixi/sound';
import { dataPath, idsPath } from '../../common/GameDataPaths';
import PQueue from 'p-queue';
import { artworkUrl } from '../artwork_url';

const METADATA_SCHEMA_VERSION = '2';

class WeaponGettable extends Gettable<WeaponData> {
    override async get(id: string, priority = 0) {
        if (id in this.data) {
            return await super.get(id);
        }

        const weapon = await super.get(id, priority);
        if (weapon.type === 'ProjectileWeaponData') {
            await Promise.all(weapon.submunitions.map(s => this.get(s.id, priority)));
        }
        return weapon;
    }
}

/**
 * Retrieves game data from the server
 */
export class GameData implements GameDataInterface {
    public readonly data: NovaDataInterfaceWithMission & {
        Sound: Gettable<sound.Sound>,
    };
    public readonly ids: Promise<NovaIDs>;
    readonly preloadData: Promise<PreloadData>;
    public loaded = Promise.resolve();
    private loadQueue = new PQueue({
        autoStart: true,
        concurrency: 16,
    });

    constructor() {
        const table: Record<string, Gettable<unknown>> = {
            Sound: this.addSoundGettable(),
        };
        for (const dataType of ALL_NOVA_DATA_TYPES) {
            const spec = NOVA_DATA_REGISTRY[dataType];
            switch (spec.clientLoader) {
                case 'weapon':
                    table[dataType] = this.addWeaponGettable();
                    break;
                case 'pict':
                    table[dataType] = this.addPictGettable<PictImageData>(dataType);
                    break;
                case 'frames':
                    table[dataType] = this.addTextureGettable<SpriteSheetFramesData>(dataType);
                    break;
                case 'soundFile':
                    table[dataType] = this.addSoundFileGettable();
                    break;
                case 'json':
                default:
                    table[dataType] = this.addGettable(dataType);
                    break;
            }
        }
        this.data = table as NovaDataInterfaceWithMission & {
            Sound: Gettable<sound.Sound>,
        };

        this.preloadData = this.preload();
        this.loaded = this.preloadData.then(() => { });

        this.ids = this.getIds();
    }

    getSettings(file: string): Promise<unknown> {
        return this.getMetadataUrl(joinPath("/settings", file));
    }

    private async preload(): Promise<PreloadData> {
        let data: PreloadData | undefined;
        try {
            const cached = await getCachedPayload<PreloadData>('/preloadData.json');
            if (cached) {
                try {
                    const headRes = await fetch('/preloadData.json', { method: 'HEAD' });
                    const serverEtag = headRes.headers.get('ETag');
                    if (serverEtag && serverEtag === cached.etag) {
                        data = cached.data;
                    }
                } catch {
                    // Fallback to fetch
                }
            }
        } catch {
            // IndexedDB fallback
        }

        if (!data) {
            const { data: fetchedData, etag } = await this.fetchMetadataWithEtag('/preloadData.json');
            data = fetchedData as PreloadData;
            if (etag) {
                void setCachedPayload('/preloadData.json', etag, data).catch(() => {});
            }
        }

        for (const [uncastKey, val] of Object.entries(data)) {
            const key = uncastKey as keyof typeof data;
            const gettable = this.data[key];
            if (gettable) {
                gettable.gotten = val;
            }
        }
        return data;
    }

    private getCachedAsset(url: string): unknown {
        return PIXI.Assets.cache.has(url) ? PIXI.Assets.cache.get(url) : undefined;
    }

    private async getUrl(url: string, priority = 0): Promise<unknown> {
        // Binary payloads are never represented in preloadData.
        if (PIXI.Assets.cache.has(url)) {
            return this.getCachedAsset(url);
        }
        return this.loadQueue.add(
            () => {
                if (PIXI.Assets.cache.has(url)) {
                    return this.getCachedAsset(url);
                }
                return PIXI.Assets.load(url);
            },
            { priority },
        );
    }

    private async fetchMetadataWithEtag(url: string, maxRetries = 4, delayMs = 1200): Promise<{ data: unknown; etag: string | null }> {
        try {
            const cached = await getCachedPayload<unknown>(url);
            if (cached) {
                return { data: cached.data, etag: cached.etag };
            }
        } catch {
            // Fallback to network fetch
        }

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(url);
                if (response.ok) {
                    const etag = response.headers.get('ETag');
                    const data = await response.json();
                    if (etag) {
                        void setCachedPayload(url, etag, data).catch(() => {});
                    }
                    return { data, etag };
                }
                if (attempt < maxRetries && (response.status === 502 || response.status === 503 || response.status === 504 || response.status === 404)) {
                    await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
                    continue;
                }
                throw new Error(`Failed to load metadata ${url}: ${
                    response.status} ${response.statusText}`);
            } catch (error) {
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
                    continue;
                }
                throw error;
            }
        }
        throw new Error(`Failed to load metadata ${url} after ${maxRetries} attempts`);
    }

    private async fetchMetadata(url: string, maxRetries = 4, delayMs = 1200): Promise<unknown> {
        const { data } = await this.fetchMetadataWithEtag(url, maxRetries, delayMs);
        return data;
    }

    private async getMetadataUrl(
        url: string,
        priority = 0,
    ): Promise<unknown> {
        await this.preloadData;
        // A versioned URL cannot hit the old unversioned immutable response.
        // PIXI may cache this new URL in memory, while HTTP no-cache headers
        // make future browser launches revalidate it normally.
        const versionedUrl = `${url}${
            url.includes('?') ? '&' : '?'}schema=${METADATA_SCHEMA_VERSION}`;
        return this.loadQueue.add(
            () => PIXI.Assets.load(versionedUrl),
            { priority },
        );
    }

    private getDataPrefix(dataType: NovaDataType): string {
        return joinPath(dataPath, dataType);
    }

    private addGettable<T extends BaseData | SpriteSheetFramesData>(dataType: NovaDataType): Gettable<T> {
        const dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            return (await this.getMetadataUrl(
                joinPath(dataPrefix, id + ".json"), priority)) as T;
        });
    }

    private addTextureGettable<T extends BaseData | SpriteSheetFramesData>(dataType: NovaDataType): Gettable<T> {
        const dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            const result = await this.getMetadataUrl(
                joinPath(dataPrefix, id + ".json"), priority) as any;
            return (result?.data ?? result) as T;
        });
    }

    private addWeaponGettable(): WeaponGettable {
        const dataPrefix = this.getDataPrefix(NovaDataType.Weapon);
        return new WeaponGettable(async (id: string, priority: number): Promise<WeaponData> => {
            return (await this.getMetadataUrl(
                joinPath(dataPrefix, id + ".json"), priority)) as WeaponData;
        });

    }

    private addPictGettable<T extends PictImageData | SpriteSheetImageData>(dataType: NovaDataType): Gettable<T> {
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            const result = await this.getUrl(
                artworkUrl(dataType, id),
                priority,
            );
            if (result instanceof ArrayBuffer) {
                return result as T;
            }
            if (result && typeof result === 'object' && 'buffer' in result
                && (result as { buffer: unknown }).buffer instanceof ArrayBuffer) {
                return (result as { buffer: ArrayBuffer }).buffer as T;
            }
            return new ArrayBuffer(0) as T;
        });
    }

    private addSoundFileGettable() {
        const dataPrefix = this.getDataPrefix(NovaDataType.SoundFile);
        return new Gettable<SoundFile>(async (id: string, priority: number) => {
            const res = await this.getUrl(joinPath(dataPrefix, id) + '.mp3', priority);
            if (res instanceof ArrayBuffer) {
                return res;
            }
            if (ArrayBuffer.isView(res)) {
                return res.buffer.slice(res.byteOffset, res.byteOffset + res.byteLength) as ArrayBuffer;
            }
            return new ArrayBuffer(0);
        });
    }

    private url(id: string): string {
        return artworkUrl(NovaDataType.PictImage, id);
    }

    textureFromPict(id: string): PIXI.Texture {
        const pictPath = this.url(id);
        const cached = this.getCachedAsset(pictPath);
        if (cached instanceof PIXI.Texture) {
            return cached;
        }
        void PIXI.Assets.load(pictPath).catch(() => {});
        return PIXI.Texture.EMPTY;
    }

    spriteFromPict(id: string): PIXI.Sprite {
        const pictPath = this.url(id);
        const cached = this.getCachedAsset(pictPath);
        if (cached instanceof PIXI.Texture) {
            return new PIXI.Sprite(cached);
        }
        const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
        void PIXI.Assets.load(pictPath).then(loaded => {
            if (loaded instanceof PIXI.Texture) {
                sprite.texture = loaded;
            } else {
                const tex = this.getCachedAsset(pictPath);
                if (tex instanceof PIXI.Texture) {
                    sprite.texture = tex;
                }
            }
        }).catch(err => {
            console.warn(`Failed to load pict ${id}`, err);
        });
        return sprite;
    }

    async textureFromPictAsync(id: string, priority?: number): Promise<PIXI.Texture> {
        const pictPath = this.url(id);
        const cached = this.getCachedAsset(pictPath);
        if (cached instanceof PIXI.Texture) {
            return cached;
        }
        const loaded = await this.getUrl(pictPath, priority);
        if (loaded instanceof PIXI.Texture) {
            return loaded;
        }
        const finalCached = this.getCachedAsset(pictPath);
        if (finalCached instanceof PIXI.Texture) {
            return finalCached;
        }
        return PIXI.Texture.EMPTY;
    }

    async spriteFromPictAsync(id: string, priority?: number) {
        const texture = await this.textureFromPictAsync(id, priority);
        return new PIXI.Sprite(texture);
    }

    async textureFromCicn(id: string): Promise<PIXI.Texture> {
        const cicnPath = artworkUrl(NovaDataType.CicnImage, id);
        try {
            const loaded = await this.getUrl(cicnPath);
            if (loaded instanceof PIXI.Texture) {
                return loaded;
            }
        } catch {
            // fallback below
        }
        const cached = this.getCachedAsset(cicnPath);
        return (cached instanceof PIXI.Texture) ? cached : PIXI.Texture.EMPTY;
    }

    private addSoundGettable() {
        const dataPrefix = this.getDataPrefix(NovaDataType.SoundFile);
        return new Gettable<sound.Sound>(async (id) => {
            // Several gameplay sounds (for example the capture and target
            // clicks) have no retail snd resource. Skip the request instead of
            // producing a server 404 each time.
            const ids = await this.ids.catch(() => undefined);
            if (ids?.SoundFile && !ids.SoundFile.includes(id)) {
                throw new Error(`No sound resource ${id}`);
            }
            const soundPath = joinPath(dataPrefix, id) + '.mp3';
            return new Promise((fulfill, reject) => {
                sound.Sound.from({
                    url: soundPath,
                    preload: true,
                    loaded: (err, sound) => {
                        if (err || !sound) {
                            reject(err);
                            return;
                        }
                        fulfill(sound);
                    }
                });
            })
        });
    }

    private async getIds(): Promise<NovaIDs> {
        return this.fetchMetadata(idsPath + ".json") as Promise<NovaIDs>;
        //const res = await ((await this.getUrl(idsPath + ".json")) as unknown) as NovaIDs;

        //return res;
        //return JSON.parse(idsBuffer.toString('utf8'));
    }
}
