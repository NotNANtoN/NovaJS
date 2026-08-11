import { Animation, AnimationImage } from "novadatainterface/animation";
import { Resource } from "nova_ecs/resource";
import { AnimationGraphic } from "./animation_graphic.js";

/**
 * Identifies which AnimationGraphics are interchangeable. Two animations with
 * the same key draw with the same sprite sheets and blend modes, so a graphic
 * built for one can be reused for the other.
 */
export function animationPoolKey(animation: Animation): string {
    const images = Object.entries(animation.images)
        // Undefined slots (a shän with no weapImage, say) contribute
        // nothing, exactly like an absent key — a graphic built without
        // an overlay must never be reused for one that needs it.
        .filter((entry): entry is [string, AnimationImage] => Boolean(entry[1]))
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
     * (the pool for this animation is full, or the graphic never finished
     * building), the caller should detach the graphic so it can be garbage
     * collected.
     *
     * The key comes from the graphic's OWN `builtAnimation` and deliberately
     * cannot be supplied by the caller. Filing a graphic under the animation
     * its entity happened to carry at death was the source of cross-weapon
     * sprite corruption: an entity's `AnimationComponent` can be reassigned
     * after its graphic is built (any `Provide` with an `update:` list does
     * this, e.g. ProjectileAnimationProvider when ProjectileDataComponent
     * changes), but AnimationGraphicLoader declares no `update:`, so the
     * graphic is never rebuilt and still holds the ORIGINAL weapon's sprite
     * sheets. Releasing it under the new animation's key put a graphic
     * drawing weapon A into weapon B's pool, and the next B projectile to
     * acquire it drew A's shot. Keying off what the graphic actually holds
     * makes that misfiling unrepresentable.
     */
    release(graphic: AnimationGraphic): boolean {
        const animation = graphic.builtAnimation;
        if (!animation) {
            // Still loading its sheets: it has no settled identity, so it
            // cannot be filed. The caller detaches it instead.
            return false;
        }
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
