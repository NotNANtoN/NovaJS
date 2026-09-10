import { SpriteSheetFramesData } from "novadatainterface/SpriteSheetData";
import * as PIXI from "pixi.js";
import { dataPath } from "../common/GameDataPaths";
import { preferredArtworkPath } from "../client/artwork_url";

const atlasTextures = new Map<string, Promise<PIXI.Texture>>();
const framesCache = new WeakMap<SpriteSheetFramesData, Promise<PIXI.Texture[]>>();
const resolvedFramesCache = new WeakMap<SpriteSheetFramesData, PIXI.Texture[]>();

export function getTexturesFromFramesCached(framesData: SpriteSheetFramesData): PIXI.Texture[] | undefined {
    return resolvedFramesCache.get(framesData);
}

function resolveAtlasUrl(image: string) {
    if (image.startsWith('/') || /^[a-z][a-z\d+.-]*:\/\//i.test(image)) {
        return image;
    }
    // The parser emits paths like "../SpriteSheetImage/<id>.png" relative to
    // the SpriteSheetFrames directory. The server serves the atlas at
    // dataPath/SpriteSheetImage/<id>.png, so resolve by basename.
    const basename = preferredArtworkPath(image.split('/').pop()!);
    const cleanBase = dataPath.endsWith("/") ? dataPath.slice(0, -1) : dataPath;
    return `${cleanBase}/SpriteSheetImage/${basename}`;
}

function getGpuMaxTextureDimension(): number {
    if (typeof window !== 'undefined') {
        const app = (window as any).app;
        const gpuLimit = app?.renderer?.gpu?.device?.limits?.maxTextureDimension2D;
        if (typeof gpuLimit === 'number' && gpuLimit > 0) return gpuLimit;
        const gl = (app?.renderer as any)?.gl;
        if (gl && typeof gl.getParameter === 'function') {
            const glLimit = gl.getParameter(0x0D33); // gl.MAX_TEXTURE_SIZE
            if (typeof glLimit === 'number' && glLimit > 0) return glLimit;
        }
    }
    return 16384;
}

async function loadDownscaledAtlas(url: string, scale: number): Promise<PIXI.Texture> {
    if (typeof document === 'undefined') {
        return await loadAtlasTexture(url);
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const loaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (err) => reject(err);
    });
    img.src = url;
    await loaded;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(img.naturalWidth * scale);
    canvas.height = Math.floor(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create 2d canvas context for atlas downscale');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return PIXI.Texture.from(canvas);
}

function loadAtlasTexture(url: string) {
    let atlas = atlasTextures.get(url);
    if (!atlas) {
        atlas = (PIXI.Assets.load(url) as Promise<PIXI.Texture>).catch(error => {
            atlasTextures.delete(url);
            throw error;
        });
        atlasTextures.set(url, atlas);
    }
    return atlas;
}

export async function texturesFromFrames(framesData: SpriteSheetFramesData): Promise<PIXI.Texture[]> {
    const syncCached = resolvedFramesCache.get(framesData);
    if (syncCached) {
        return syncCached;
    }
    let cached = framesCache.get(framesData);
    if (cached) {
        return await cached;
    }

    const promise = (async () => {
        const frameNames = Object.keys(framesData.frames);

        if (framesData.meta?.image) {
            const url = resolveAtlasUrl(framesData.meta.image);
            const maxDim = getGpuMaxTextureDimension();
            const rawW = framesData.meta.size?.w ?? 0;
            const rawH = framesData.meta.size?.h ?? 0;
            const scale = (rawW > maxDim || rawH > maxDim) && (rawW > 0 && rawH > 0)
                ? Math.min(maxDim / rawW, maxDim / rawH)
                : 1;
            const atlas = scale < 1
                ? await loadDownscaledAtlas(url, scale)
                : await loadAtlasTexture(url);
            const textures = frameNames.map(frameName => {
                const { x, y, w, h } = framesData.frames[frameName].frame;
                return new PIXI.Texture({
                    source: atlas.source,
                    frame: new PIXI.Rectangle(
                        scale === 1 ? x : Math.floor(x * scale),
                        scale === 1 ? y : Math.floor(y * scale),
                        scale === 1 ? w : Math.floor(w * scale),
                        scale === 1 ? h : Math.floor(h * scale),
                    ),
                });
            });
            resolvedFramesCache.set(framesData, textures);
            return textures;
        }

        // Texture.from only reads Pixi's cache in v8; it does not load a URL.
        const textures = await Promise.all(frameNames.map(frameName =>
            PIXI.Assets.load<PIXI.Texture>(frameName)));
        resolvedFramesCache.set(framesData, textures);
        return textures;
    })();

    framesCache.set(framesData, promise);
    try {
        return await promise;
    } catch (error) {
        // A failed atlas must not permanently cache empty/missing frame textures.
        framesCache.delete(framesData);
        throw error;
    }
}
