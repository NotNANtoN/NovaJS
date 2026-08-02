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
     * fully unfolded), advanced by ShipBaseSetAnimationSystem for
     * jump-folding ships (the Argosy's nacelles). Miner claws use the SIM-side
     * FoldStateComponent instead, since their fold gates weapon fire.
     *
     * Note this is the FOLD's semantics, not the art's: the stock fold
     * sprite sets run deployed (set 0) -> folded (last set), so
     * foldSetIndex maps this in reverse.
     */
    foldProgress = 0;
    /**
     * Display-only alpha of the shän `weapImage` weapon-effect overlay, in
     * [0, 1]. Snapped to 1 while the ship is firing and decayed back toward
     * 0 at the shän's WeapDecay rate afterwards (ShipAnimationSystem).
     */
    weaponFlashAlpha = 0;
    private animation: Animation | Promise<Animation>;
    readonly buildPromise: Promise<AnimationGraphic>;
    built = false;
    size = { x: 0, y: 0 }
    /**
     * The running-lights blink pattern for this animation, or null for a
     * steady light / no lights. Resolved once the graphic is built.
     */
    blink: BlinkPattern | null = null;
    /**
     * The shän's WeapDecay (percent of the weapon overlay's alpha burned
     * per 30th-of-a-second frame once firing stops). Static per animation,
     * so it is resolved once at build time like `blink`, and survives
     * pooling (the pool keys graphics by animation).
     */
    weapDecay = 0;

    constructor({ displayAssets, animation }: { displayAssets: DisplayAssetDataInterface, animation: Animation | Promise<Animation> }) {
        this.animation = animation;
        this.displayAssets = displayAssets;
        this.rotation = 0;
        this.buildPromise = this.build();
    }

    private async build(): Promise<AnimationGraphic> {
        var promises: Promise<unknown>[] = [];
        this.blink = (await this.animation).blink;
        this.weapDecay = (await this.animation).weapDecay;
        for (const imageName in (await this.animation).images) {
            const image = (await this.animation).images[imageName];
            if (!image) {
                // A sprite layer the shän does not define (most ships
                // have no weapImage / altImage / shieldImage). Draw
                // NOTHING for it — never fall back to a default sheet.
                continue;
            }
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
        // The weapon-effect overlay only shows while firing, so a freshly
        // built graphic starts transparent rather than flashing for the
        // frame before ShipAnimationSystem first runs.
        this.weapAlpha = 0;
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
        this.weaponFlashAlpha = 0;
        this.weapAlpha = 0;
        this.rotation = 0;
    }

    set glowAlpha(alpha: number) {
        const glowImage = this.sprites.get('glowImage');
        if (glowImage) {
            glowImage.pixiSprite.alpha = alpha;
        }
    }

    /**
     * Alpha of the weapon-effect overlay (shän WeapImage), the same
     * per-sprite-alpha composition the engine glow uses. Fully transparent
     * hides the sprite outright so a ship that never fires costs nothing.
     */
    set weapAlpha(alpha: number) {
        const weapImage = this.sprites.get('weapImage');
        if (weapImage) {
            weapImage.pixiSprite.alpha = alpha;
            weapImage.pixiSprite.visible = alpha > 0;
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
