import * as PIXI from "pixi.js";
import { Animation, BlinkPattern } from "novadatainterface/animation";
import { DisplayAssetDataInterface } from "../client/gamedata/display_asset_data.js";
import { SpriteSheetSprite } from "./sprite_sheet_sprite.js";

/**
 * An AnimationGraphic is responsible for managing all the PIXI Sprites
 * needed to draw a single animation, be it a ship, explosion, asteroid,
 * or planet.
 */
export class AnimationGraphic {
    // AnimationGraphic is not a Drawable since it doesn't draw a state.
    readonly container = new PIXI.Container();
    protected readonly displayAssets: DisplayAssetDataInterface;
    readonly sprites = new Map<string, SpriteSheetSprite>();
    private wrappedProgress = 0;
    private wrappedRotation = 0;
    /**
     * Display-only fold animation progress in [0, 1] (0 = folded/rest, 1 =
     * fully unfolded), advanced by ShipFoldAnimationSystem for jump-folding
     * ships (the Argosy's expanding segments). Miner claws use the SIM-side
     * FoldStateComponent instead, since their fold gates weapon fire.
     */
    foldProgress = 0;
    private animation: Animation | Promise<Animation>;
    readonly buildPromise: Promise<AnimationGraphic>;
    built = false;
    size = { x: 0, y: 0 }
    /**
     * The running-lights blink pattern for this animation, or null for a
     * steady light / no lights. Resolved once the graphic is built.
     */
    blink: BlinkPattern | null = null;

    constructor({ displayAssets, animation }: { displayAssets: DisplayAssetDataInterface, animation: Animation | Promise<Animation> }) {
        this.animation = animation;
        this.displayAssets = displayAssets;
        this.rotation = 0;
        this.buildPromise = this.build();
    }

    private async build(): Promise<AnimationGraphic> {
        var promises: Promise<unknown>[] = [];
        this.blink = (await this.animation).blink;
        for (const imageName in (await this.animation).images) {
            const image = (await this.animation).images[imageName];
            const sprite = new SpriteSheetSprite({
                image,
                displayAssets: this.displayAssets
            });

            this.sprites.set(imageName, sprite);
            this.container.addChild(sprite.pixiSprite);
            promises.push(sprite.buildPromise);
        }
        await Promise.all(promises);
        this.size.x = Math.max(0, ...[...this.sprites.values()].map(s => s.size.x));
        this.size.y = Math.max(0, ...[...this.sprites.values()].map(s => s.size.y));
        this.rotation = this.rotation;
        this.built = true;
        return this;
    }

    /**
     * Resets mutable display state so a pooled graphic looks like a freshly
     * built one when it is reused for a new entity. Visibility of the
     * container itself is managed by whoever attaches the graphic.
     */
    reset() {
        this.setFramesToUse('normal');
        for (const sprite of this.sprites.values()) {
            sprite.pixiSprite.visible = true;
            sprite.pixiSprite.tint = 0xFFFFFF;
            sprite.pixiSprite.alpha = 1;
        }
        // The container's alpha (murk fade) and scale (debris chunk
        // scale) may have been changed.
        this.container.alpha = 1;
        this.container.scale.set(1);
        this.wrappedProgress = 0;
        this.foldProgress = 0;
        this.rotation = 0;
    }

    set glowAlpha(alpha: number) {
        const glowImage = this.sprites.get('glowImage');
        if (glowImage) {
            glowImage.pixiSprite.alpha = alpha;
        }
    }

    setFramesToUse(frames: string) {
        for (const sprite of this.sprites.values()) {
            sprite.setFramesToUse(frames);
        }
    }

    get rotation() {
        return this.wrappedRotation;
    }

    set rotation(angle: number) {
        this.wrappedRotation = angle;
        for (const sprite of this.sprites.values()) {
            sprite.rotation = angle;
        }
    }

    get progress() {
        return this.wrappedProgress;
    }

    set progress(progress: number) {
        progress = Math.min(1, Math.max(0, progress));
        for (const sprite of this.sprites.values()) {
            sprite.rotation = 0;
            sprite.frame = Math.min(sprite.frames - 1,
                Math.floor(progress * sprite.frames));
        }
    }
}
