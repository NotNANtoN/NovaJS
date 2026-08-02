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

// The pool never calls methods on the graphics it holds, so a plain object
// stand-in is sufficient.
function makeGraphic(): AnimationGraphic {
    return {} as AnimationGraphic;
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
        const graphic = makeGraphic();
        expect(pool.release(animation, graphic)).toBeTrue();
        expect(pool.acquire(animation)).toBe(graphic);
        expect(pool.acquire(animation)).toBeUndefined();
    });

    it('does not return a graphic for a different animation', () => {
        const pool = new AnimationGraphicPool();
        expect(pool.release(makeAnimation('a'), makeGraphic())).toBeTrue();
        expect(pool.acquire(makeAnimation('b'))).toBeUndefined();
    });

    it('rejects graphics beyond maxPerKey', () => {
        const pool = new AnimationGraphicPool(2);
        const animation = makeAnimation('a');
        expect(pool.release(animation, makeGraphic())).toBeTrue();
        expect(pool.release(animation, makeGraphic())).toBeTrue();
        expect(pool.release(animation, makeGraphic())).toBeFalse();
        // A different animation has its own limit.
        expect(pool.release(makeAnimation('b'), makeGraphic())).toBeTrue();
    });
});
