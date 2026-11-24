import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from "nova_ecs/world";
import * as PIXI from "pixi.js";
import {
    BeamClippingSystem,
    BeamDataComponent,
    BeamStateComponent,
    BeamSystem,
} from "../nova_plugin/beam_plugin";
import { Optional } from "nova_ecs/optional";
import { Space } from "./space_resource";
import { attachGraphic, ManagedGraphic } from './managed_graphic';

let cachedCoronaTexture: PIXI.Texture | undefined;

function getCoronaTexture(): PIXI.Texture {
    if (cachedCoronaTexture && !cachedCoronaTexture.destroyed) {
        return cachedCoronaTexture;
    }
    const width = 4;
    const height = 64;
    const pixels = new Uint8Array(width * height * 4);
    const half = (height - 1) / 2;
    for (let y = 0; y < height; y++) {
        const dist = Math.abs(y - half) / half;
        // Smooth quadratic falloff matching multi-pass additive corona glow.
        const alpha = Math.max(0, Math.min(255, Math.round(Math.pow(1 - dist, 2.2) * 255)));
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            pixels[idx] = 255;
            pixels[idx + 1] = 255;
            pixels[idx + 2] = 255;
            pixels[idx + 3] = alpha;
        }
    }
    const source = new PIXI.BufferImageSource({
        resource: pixels,
        width,
        height,
    });
    source.style.scaleMode = 'linear';
    cachedCoronaTexture = new PIXI.Texture({ source });
    return cachedCoronaTexture;
}

class BeamDisplayPool {
    readonly root = new PIXI.Container();
    readonly spriteLayer = new PIXI.Container();
    readonly lightningGraphics = new PIXI.Graphics();
    readonly managed: ManagedGraphic;
    private readonly sprites: PIXI.Sprite[] = [];
    private activeSpriteCount = 0;
    private previousActiveSpriteCount = 0;
    lightningDrawn = false;

    constructor(space: PIXI.Container) {
        this.root.label = 'BeamDisplayRoot';
        this.spriteLayer.label = 'BeamSprites';
        this.lightningGraphics.label = 'BeamLightningGraphics';
        this.root.addChild(this.spriteLayer);
        this.root.addChild(this.lightningGraphics);
        this.managed = attachGraphic(space, this.root);
    }

    beginFrame() {
        for (let i = 0; i < this.previousActiveSpriteCount; i++) {
            this.sprites[i].visible = false;
        }
        this.previousActiveSpriteCount = 0;
        this.activeSpriteCount = 0;
        if (this.lightningDrawn) {
            this.lightningGraphics.clear();
            this.lightningDrawn = false;
        }
    }

    acquireSprite(texture: PIXI.Texture): PIXI.Sprite {
        const index = this.activeSpriteCount++;
        let sprite = this.sprites[index];
        if (!sprite) {
            sprite = new PIXI.Sprite(texture);
            sprite.anchor.set(0, 0.5);
            this.sprites.push(sprite);
            this.spriteLayer.addChild(sprite);
        } else if (sprite.texture !== texture) {
            sprite.texture = texture;
        }
        sprite.visible = true;
        if (this.activeSpriteCount > this.previousActiveSpriteCount) {
            this.previousActiveSpriteCount = this.activeSpriteCount;
        }
        return sprite;
    }

    dispose() {
        this.sprites.length = 0;
        this.managed.dispose();
    }
}

const BeamDisplayResource = new Resource<BeamDisplayPool>('BeamDisplayPool');

const ClearBeams = new System({
    name: 'ClearBeams',
    args: [BeamDisplayResource, SingletonComponent] as const,
    step(pool) {
        pool.beginFrame();
    }
});

export const BeamDisplaySystem = new System({
    name: 'BeamDisplay',
    args: [BeamDataComponent, Optional(BeamStateComponent), MovementStateComponent,
        BeamDisplayResource] as const,
    step(beamData, beamState, movement, pool) {
        const { width, beamColor, coronaColor, coronaFalloff, length, lightningAmplitude, lightningDensity }
            = beamData.beamAnimation;
        const beamRgb = (beamColor ?? 0xffffff) & 0xffffff;
        const coronaRgb = (coronaColor ?? 0x8888ff) & 0xffffff;
        const effectiveLength = Math.max(0, Math.min(
            length, beamState?.length ?? length));
        if (effectiveLength <= 0) {
            return;
        }

        const isPool = typeof (pool as BeamDisplayPool).acquireSprite === 'function';
        const beamGraphics = isPool
            ? pool.lightningGraphics
            : ((pool as unknown as ManagedGraphic).root as PIXI.Graphics);

        if (lightningDensity > 0) {
            const destination = movement.rotation.getUnitVector()
                .scale(effectiveLength).add(movement.position);
            const rng = Math.random;
            const lightningAmplitudeScale = 2;
            beamGraphics.moveTo(movement.position.x, movement.position.y);
            const direction = destination.subtract(movement.position);
            for (let i = 1; i <= lightningDensity; i++) {
                const center = movement.position.add(direction.scale(i / (lightningDensity + 2)));
                const offset = {
                    x: (rng() * 2 - 1) * lightningAmplitude * lightningAmplitudeScale,
                    y: (rng() * 2 - 1) * lightningAmplitude * lightningAmplitudeScale
                };
                const point = center.add(offset);
                beamGraphics.lineTo(point.x, point.y);
            }
            beamGraphics.lineTo(destination.x, destination.y);
            beamGraphics.stroke({ width, color: beamRgb });
            if (isPool) {
                pool.lightningDrawn = true;
            }
            return;
        }

        if (!isPool) {
            const destination = movement.rotation.getUnitVector()
                .scale(effectiveLength).add(movement.position);
            beamGraphics.moveTo(movement.position.x, movement.position.y);
            beamGraphics.lineTo(destination.x, destination.y);
            beamGraphics.stroke({ width: width + 2, color: coronaRgb });
            beamGraphics.moveTo(movement.position.x, movement.position.y);
            beamGraphics.lineTo(destination.x, destination.y);
            beamGraphics.stroke({ width, color: beamRgb });
            return;
        }

        // Non-lightning beams render as pooled GPU quads instead of multi-pass
        // Graphics tessellation every frame.
        const beamAngle = movement.rotation.angle - Math.PI / 2;
        const x = movement.position.x;
        const y = movement.position.y;
        const coronaScale = 2 * 16;
        const coronaWidth = coronaFalloff >= 2
            ? coronaScale / coronaFalloff
            : 2;

        const coronaSprite = pool.acquireSprite(getCoronaTexture());
        coronaSprite.position.set(x, y);
        coronaSprite.rotation = beamAngle;
        coronaSprite.width = effectiveLength;
        coronaSprite.height = Math.max(2, width + 2 + coronaWidth);
        coronaSprite.tint = coronaRgb;
        coronaSprite.alpha = coronaFalloff >= 2 ? 0.8 : 0.95;
        coronaSprite.blendMode = 'add';

        const coreSprite = pool.acquireSprite(PIXI.Texture.WHITE);
        coreSprite.position.set(x, y);
        coreSprite.rotation = beamAngle;
        coreSprite.width = effectiveLength;
        coreSprite.height = Math.max(1, width);
        coreSprite.tint = beamRgb;
        coreSprite.alpha = 1;
        coreSprite.blendMode = 'normal';
    },
    after: [ClearBeams, BeamSystem, BeamClippingSystem],
    before: []
});


export const BeamDisplayPlugin: Plugin = {
    name: 'BeamDisplayPlugin',
    build(world) {
        const space = world.resources.get(Space);
        if (!space) {
            throw new Error('Expected space resource');
        }
        world.resources.set(BeamDisplayResource, new BeamDisplayPool(space));
        world.addSystem(ClearBeams);
        world.addSystem(BeamDisplaySystem);
    },
    remove(world) {
        world.resources.get(BeamDisplayResource)?.dispose();
        world.removeSystem(BeamDisplaySystem);
        world.removeSystem(ClearBeams);
        world.resources.delete(BeamDisplayResource);
    }
};
