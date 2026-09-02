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
            try {
                const atlas = await loadAtlasTexture(resolveAtlasUrl(framesData.meta.image));
                const textures = frameNames.map(frameName => {
                    const { x, y, w, h } = framesData.frames[frameName].frame;
                    return new PIXI.Texture({
                        source: atlas.source,
                        frame: new PIXI.Rectangle(x, y, w, h),
                    });
                });
                resolvedFramesCache.set(framesData, textures);
                return textures;
            } catch (error) {
                // Fall back to the legacy endpoint-per-frame behavior if the atlas
                // is unavailable.
                console.warn('Failed to load sprite sheet atlas', error);
            }
        }

        const textures = frameNames.map(frameName => PIXI.Texture.from(frameName));
        resolvedFramesCache.set(framesData, textures);
        return textures;
    })();

    framesCache.set(framesData, promise);
    return await promise;
}
