import 'jasmine';
import { Animation, getDefaultAnimation, getDefaultAnimationImage } from 'novadatainterface/animation';
import { AnimationGraphic } from './animation_graphic.js';
import { AnimationGraphicPool, animationPoolKey } from './animation_graphic_pool.js';

function makeAnimation(id: string, imageId = id): Animation {
    const animation = getDefaultAnimation();
    animation.id = id;
    animation.images = {
        baseImage: {
            ...getDefaultAnimationImage(),
            id: imageId,
        },
    };
    return animation;
}

// The pool never calls methods on the graphics it holds — it only reads
// `builtAnimation` — so a plain object stand-in is sufficient. This keeps
// the spec PIXI-free (AnimationGraphic allocates PIXI display objects,
// which do not construct headlessly).
function makeGraphic(builtAnimation?: Animation): AnimationGraphic {
    return { builtAnimation } as AnimationGraphic;
}

describe('animationPoolKey', () => {
    it('is the same for animations that draw the same', () => {
        expect(animationPoolKey(makeAnimation('a')))
            .toEqual(animationPoolKey(makeAnimation('a')));
    });

    it('differs for animations with different ids', () => {
        expect(animationPoolKey(makeAnimation('a')))
            .not.toEqual(animationPoolKey(makeAnimation('b')));
    });

    it('differs for animations with the same id but different images', () => {
        expect(animationPoolKey(makeAnimation('a', 'image1')))
            .not.toEqual(animationPoolKey(makeAnimation('a', 'image2')));
    });

    it('treats an undefined image slot as absent', () => {
        // Most shäns define no weapon-effect overlay at all (the Fed
        // Carrier among them). Such a slot must key exactly like a
        // missing key, and must never contribute a default sprite.
        const absent = makeAnimation('a');
        const explicitlyUndefined = makeAnimation('a');
        explicitlyUndefined.images.weapImage = undefined;

        expect(animationPoolKey(explicitlyUndefined))
            .toEqual(animationPoolKey(absent));
        expect(animationPoolKey(explicitlyUndefined))
            .not.toContain('weapImage');
    });

    it('differs from an animation that does have an overlay', () => {
        const withOverlay = makeAnimation('a');
        withOverlay.images.weapImage = {
            ...getDefaultAnimationImage(),
            id: 'weap sheet',
        };
        expect(animationPoolKey(withOverlay))
            .not.toEqual(animationPoolKey(makeAnimation('a')));
    });
});

describe('AnimationGraphicPool', () => {
    it('returns undefined when empty', () => {
        const pool = new AnimationGraphicPool();
        expect(pool.acquire(makeAnimation('a'))).toBeUndefined();
    });

    it('returns a released graphic for the same animation', () => {
        const pool = new AnimationGraphicPool();
        const animation = makeAnimation('a');
        const graphic = makeGraphic(animation);
        expect(pool.release(graphic)).toBeTrue();
        expect(pool.acquire(animation)).toBe(graphic);
        expect(pool.acquire(animation)).toBeUndefined();
    });

    it('does not return a graphic for a different animation', () => {
        const pool = new AnimationGraphicPool();
        expect(pool.release(makeGraphic(makeAnimation('a')))).toBeTrue();
        expect(pool.acquire(makeAnimation('b'))).toBeUndefined();
    });

    it('rejects graphics beyond maxPerKey', () => {
        const pool = new AnimationGraphicPool(2);
        const animation = makeAnimation('a');
        expect(pool.release(makeGraphic(animation))).toBeTrue();
        expect(pool.release(makeGraphic(animation))).toBeTrue();
        expect(pool.release(makeGraphic(animation))).toBeFalse();
        // A different animation has its own limit.
        expect(pool.release(makeGraphic(makeAnimation('b')))).toBeTrue();
    });

    // The cross-weapon sprite corruption this pool used to cause. An
    // entity's AnimationComponent can be REASSIGNED after its graphic is
    // built — any Provide with an `update:` list replaces it, and
    // AnimationGraphicLoader declares no `update:`, so the graphic is never
    // rebuilt and keeps the original weapon's sprite sheets. Releasing it
    // under whatever animation the entity carried at death filed a graphic
    // drawing weapon A into weapon B's pool, and the next B projectile to
    // acquire it drew A's shot. The pool must key off what the graphic
    // actually holds, which the release signature now makes the only option.
    it('files a graphic by what it was built from, not by its entity\'s '
        + 'current animation', () => {
            const pool = new AnimationGraphicPool();
            const built = makeAnimation('fast weapon');
            const repurposed = makeAnimation('other weapon');
            const graphic = makeGraphic(built);

            expect(pool.release(graphic)).toBeTrue();

            // The animation the dying entity now carries must NOT hand out
            // a graphic still holding the other weapon's sheets.
            expect(pool.acquire(repurposed)).toBeUndefined();
            expect(pool.acquire(built)).toBe(graphic);
        });

    it('refuses a graphic that has not finished building', () => {
        // No builtAnimation yet means no settled identity to key by, so it
        // must not be pooled under a guess. The caller detaches it instead.
        const pool = new AnimationGraphicPool();
        expect(pool.release(makeGraphic(undefined))).toBeFalse();
        expect(pool.acquire(makeAnimation('a'))).toBeUndefined();
    });

    it('keeps a graphic acquirable only under its own key across many '
        + 'release/acquire cycles', () => {
            // A fast-firing weapon churns its pool constantly. No amount of
            // churn may leak one of its graphics into another weapon's pool.
            const pool = new AnimationGraphicPool();
            const fast = makeAnimation('fast weapon');
            const slow = makeAnimation('slow weapon');
            const slowGraphic = makeGraphic(slow);
            pool.release(slowGraphic);

            for (let i = 0; i < 100; i++) {
                const g = pool.acquire(fast) ?? makeGraphic(fast);
                expect(g.builtAnimation).toBe(fast);
                pool.release(g);
            }

            expect(pool.acquire(slow)).toBe(slowGraphic);
        });
});
