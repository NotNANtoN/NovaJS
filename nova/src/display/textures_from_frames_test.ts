import 'jasmine';
import * as PIXI from 'pixi.js';
import { getDefaultSpriteSheetFrames } from 'novadatainterface/SpriteSheetData';
import { getDefaultAnimation } from 'novadatainterface/Animation';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { Gettable } from 'novadatainterface/Gettable';
import { getTexturesFromFramesCached, texturesFromFrames } from './textures_from_frames';
import { SpriteSheetSprite } from './sprite_sheet_sprite';
import { AnimationGraphic } from './animation_graphic';

function frames(image: string) {
    const frames = getDefaultSpriteSheetFrames();
    frames.meta.image = image;
    frames.frames['default 0.png'].frame = { x: 0, y: 0, w: 1, h: 1 };
    return frames;
}

describe('flight texture loading', () => {
    it('retries a failed atlas instead of caching missing frame textures', async () => {
        const data = frames('/retry-atlas.png');
        const load = spyOn(PIXI.Assets, 'load').and.rejectWith(new Error('offline'));
        await expectAsync(texturesFromFrames(data)).toBeRejectedWithError('offline');
        expect(getTexturesFromFramesCached(data)).toBeUndefined();
        load.and.callFake(async () => PIXI.Texture.WHITE);
        const textures = await texturesFromFrames(data);
        expect(textures[0].source).toBe(PIXI.Texture.WHITE.source);
        expect(getTexturesFromFramesCached(data)).toBe(textures);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('deduplicates concurrent atlas requests', async () => {
        const load = spyOn(PIXI.Assets, 'load').and.callFake(async () => PIXI.Texture.WHITE);
        await Promise.all([
            texturesFromFrames(frames('/shared-atlas.png')),
            texturesFromFrames(frames('/shared-atlas.png')),
        ]);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('actually loads legacy frame URLs', async () => {
        const load: jasmine.Spy = spyOn(PIXI.Assets, 'load').and.callFake(async () => PIXI.Texture.WHITE);
        const textures = await texturesFromFrames(frames(''));
        expect(load).toHaveBeenCalledWith('default 0.png');
        expect(textures).toEqual([PIXI.Texture.WHITE]);
    });

    it('assigns the first texture even when the cold sprite faces zero radians', async () => {
        spyOn(PIXI.Assets, 'load').and.callFake(async () => PIXI.Texture.WHITE);
        const data = frames('/zero-angle.png');
        const gameData = { data: { SpriteSheetFrames: new Gettable(async () => data) } } as unknown as GameDataInterface;
        const sprite = new SpriteSheetSprite({ gameData, image: getDefaultAnimation().images.baseImage });
        await sprite.buildPromise;
        expect(sprite.pixiSprite.texture.source).toBe(PIXI.Texture.WHITE.source);
        sprite.pixiSprite.destroy();
    });

    it('builds a warmed projectile graphic synchronously on its first spawn', async () => {
        spyOn(PIXI.Assets, 'load').and.callFake(async () => PIXI.Texture.WHITE);
        const data = frames('/instant-projectile.png');
        const sheets = new Gettable(async () => data);
        const animation = getDefaultAnimation();
        await texturesFromFrames(await sheets.get(animation.images.baseImage.id));
        const graphic = new AnimationGraphic({
            animation, gameData: { data: { SpriteSheetFrames: sheets } } as unknown as GameDataInterface,
        });
        expect(graphic.built).toBeTrue();
        expect(graphic.container.children.length).toBeGreaterThan(0);
        graphic.dispose();
    });

    it('does not attach sprites after an animation was disposed during loading', async () => {
        const gameData = { data: {} } as GameDataInterface;
        const graphic = new AnimationGraphic({ gameData, animation: Promise.resolve(getDefaultAnimation()) });
        graphic.dispose();
        await expectAsync(graphic.buildPromise).toBeResolved();
        expect(graphic.managed.disposed).toBeTrue();
        expect(graphic.built).toBeFalse();
    });
});
