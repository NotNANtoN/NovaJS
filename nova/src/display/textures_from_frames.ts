import { SpriteSheetFramesData } from "novadatainterface/SpriteSheetData";
import * as PIXI from "pixi.js";
import { dataPath } from "../common/GameDataPaths";
import urlJoin from "url-join";

const atlasTextures = new Map<string, Promise<PIXI.Texture>>();

function resolveAtlasUrl(image: string) {
    if (image.startsWith('/') || /^[a-z][a-z\d+.-]*:\/\//i.test(image)) {
        return image;
    }
    // The parser emits paths like "../SpriteSheetImage/<id>.png" relative to
    // the SpriteSheetFrames directory. The server serves the atlas at
    // dataPath/SpriteSheetImage/<id>.png, so resolve by basename.
    const basename = image.split('/').pop()!;
    return urlJoin(dataPath, 'SpriteSheetImage', basename);
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

export async function texturesFromFrames(framesData: SpriteSheetFramesData) {
    const frameNames = Object.keys(framesData.frames);

    if (framesData.meta?.image) {
        try {
            const atlas = await loadAtlasTexture(resolveAtlasUrl(framesData.meta.image));
            return frameNames.map(frameName => {
                const { x, y, w, h } = framesData.frames[frameName].frame;
                return new PIXI.Texture(
                    atlas.baseTexture, new PIXI.Rectangle(x, y, w, h));
            });
        } catch (error) {
            // Fall back to the legacy endpoint-per-frame behavior if the atlas
            // is unavailable.
            console.warn('Failed to load sprite sheet atlas', error);
        }
    }

    return frameNames.map(frameName => PIXI.Texture.from(frameName));
}
