import { Animation } from "novadatainterface/animation";
import { Resource } from "nova_ecs/resource";
import { AnimationGraphic } from "./animation_graphic.js";

/**
 * Identifies which AnimationGraphics are interchangeable. Two animations with
 * the same key draw with the same sprite sheets and blend modes, so a graphic
 * built for one can be reused for the other.
 */
export function animationPoolKey(animation: Animation): string {
    const images = Object.entries(animation.images)
        .map(([name, image]) => `${name}=${image.id}/${image.blendMode}`)
        .sort()
        .join(',');
    return `${animation.id}|${images}`;
}

/**
 * Pools built AnimationGraphics so short-lived entities (projectiles,
 * explosions) reuse their PIXI display objects instead of destroying and
 * recreating them for every shot. This used to happen implicitly because the
 * simulation pooled projectile entities with FactoryQueue, but now that the
 * simulation runs in a worker, the display world sees every shot as a
 * brand-new entity.
 */
export class AnimationGraphicPool {
    private readonly pools = new Map<string, AnimationGraphic[]>();

    constructor(readonly maxPerKey = 64) { }

    acquire(animation: Animation): AnimationGraphic | undefined {
        return this.pools.get(animationPoolKey(animation))?.pop();
    }

    /**
     * Returns true if the graphic was accepted into the pool. If it was not
     * (the pool for this animation is full), the caller should detach the
     * graphic so it can be garbage collected.
     */
    release(animation: Animation, graphic: AnimationGraphic): boolean {
        const key = animationPoolKey(animation);
        let pool = this.pools.get(key);
        if (!pool) {
            pool = [];
            this.pools.set(key, pool);
        }
        if (pool.length >= this.maxPerKey) {
            return false;
        }
        pool.push(graphic);
        return true;
    }
}

export const AnimationGraphicPoolResource =
    new Resource<AnimationGraphicPool>('AnimationGraphicPool');
