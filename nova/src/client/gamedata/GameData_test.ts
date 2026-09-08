import 'jasmine';
import * as PIXI from 'pixi.js';
import PQueue from 'p-queue';
import type { GameData } from './GameData';
import { artworkUrl } from '../artwork_url';

// Exercise the real image methods without constructor metadata/network preload.

describe('GameData image cache', () => {
    let GameDataClass: typeof GameData;
    let data: GameData;

    beforeAll(async () => {
        // @pixi/sound probes browser audio support at import time, even though
        // these image tests never create or play sounds.
        const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
        const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { createElement: () => ({ canPlayType: () => '' }) },
        });
        Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
        try {
            GameDataClass = (await import('./GameData')).GameData;
        } finally {
            if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
            else Reflect.deleteProperty(globalThis, 'document');
            if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
            else Reflect.deleteProperty(globalThis, 'window');
        }
    });
    let queue: PQueue;
    let cache: Map<string, unknown>;
    let load: jasmine.Spy;
    let get: jasmine.Spy;
    let warn: jasmine.Spy;
    const pict = artworkUrl('PictImage', 'nova:7503');
    const texture = PIXI.Texture.WHITE;

    beforeEach(() => {
        queue = new PQueue({ concurrency: 1 });
        data = Object.assign(Object.create(GameDataClass.prototype), { loadQueue: queue });
        cache = new Map();
        spyOn(PIXI.Assets.cache, 'has').and.callFake(key => cache.has(key));
        get = spyOn(PIXI.Assets.cache, 'get').and.callFake(<T>(key: string): T => {
            if (!cache.has(key)) {
                throw new Error(`Unexpected cache miss read: ${key}`);
            }
            return cache.get(key) as T;
        });
        load = spyOn(PIXI.Assets, 'load').and.callFake(async () => texture);
        warn = spyOn(console, 'warn');
    });

    it('returns cached textures and sprites without loading', async () => {
        cache.set(pict, texture);
        expect(data.textureFromPict('nova:7503')).toBe(texture);
        expect(data.spriteFromPict('nova:7503').texture).toBe(texture);
        expect(await data.textureFromPictAsync('nova:7503')).toBe(texture);
        expect(await data.spriteFromPictAsync('nova:7503').then(s => s.texture)).toBe(texture);
        expect(load).not.toHaveBeenCalled();
        expect(get).toHaveBeenCalledWith(pict);
    });

    it('loads the reported cold button images without reading missing cache entries', async () => {
        for (const id of ['nova:7503', 'nova:7504', 'nova:7505', 'nova:7506']) {
            expect(await data.textureFromPictAsync(id, 50)).toBe(texture);
            expect(load).toHaveBeenCalledWith(artworkUrl('PictImage', id));
        }
        expect(get).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    it('returns EMPTY synchronously while starting a load', async () => {
        expect(data.textureFromPict('nova:7503')).toBe(PIXI.Texture.EMPTY);
        expect(load).toHaveBeenCalledWith(pict);
        await Promise.resolve();
        expect(get).not.toHaveBeenCalled();
    });

    it('updates a cold sprite with the loaded texture', async () => {
        const sprite = data.spriteFromPict('nova:7503');
        expect(sprite.texture).toBe(PIXI.Texture.EMPTY);
        await Promise.resolve();
        expect(sprite.texture).toBe(texture);
        expect(get).not.toHaveBeenCalled();
    });

    it('uses a texture cached by a loader that returns a non-texture', async () => {
        load.and.callFake(async () => {
            cache.set(pict, texture);
            return {};
        });
        expect(await data.textureFromPictAsync('nova:7503')).toBe(texture);
        cache.clear();
        const sprite = data.spriteFromPict('nova:7503');
        await Promise.resolve();
        expect(sprite.texture).toBe(texture);
    });

    it('keeps EMPTY fallbacks when a loader returns no texture and caches nothing', async () => {
        load.and.resolveTo({});
        expect(await data.textureFromPictAsync('nova:7503')).toBe(PIXI.Texture.EMPTY);
        const sprite = data.spriteFromPict('nova:7503');
        await Promise.resolve();
        expect(sprite.texture).toBe(PIXI.Texture.EMPTY);
        expect(await data.textureFromCicn('nova:7503')).toBe(PIXI.Texture.EMPTY);
        expect(get).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    it('preserves async PICT rejection and CICN fallback on load failure', async () => {
        const error = new Error('image load failed');
        load.and.rejectWith(error);
        await expectAsync(data.textureFromPictAsync('nova:7503')).toBeRejectedWith(error);
        expect(await data.textureFromCicn('nova:7503')).toBe(PIXI.Texture.EMPTY);
        expect(get).not.toHaveBeenCalled();
    });

    it('still reports genuine sprite load failures', async () => {
        const error = new Error('image load failed');
        load.and.rejectWith(error);
        const sprite = data.spriteFromPict('nova:7503');
        await Promise.resolve();
        await Promise.resolve();
        expect(sprite.texture).toBe(PIXI.Texture.EMPTY);
        expect(warn).toHaveBeenCalledWith('Failed to load pict nova:7503', error);
    });

    it('rechecks the cache after waiting in the load queue', async () => {
        queue.pause();
        const pending = data.textureFromPictAsync('nova:7503', 50);
        expect(queue.size).toBe(1);
        cache.set(pict, texture);
        queue.start();
        expect(await pending).toBe(texture);
        expect(load).not.toHaveBeenCalled();
    });

    it('returns cached binary payloads without loading', async () => {
        const buffer = new ArrayBuffer(4);
        cache.set(pict, buffer);
        const harness = data as unknown as {
            getUrl(url: string): Promise<unknown>;
        };
        expect(await harness.getUrl(pict)).toBe(buffer);
        expect(load).not.toHaveBeenCalled();
    });
});
