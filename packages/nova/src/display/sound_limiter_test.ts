import 'jasmine';
import {
    MAX_SAME_SOUND_STARTS_PER_FRAME, SoundStartLimiter,
} from './sound_limiter.js';

/** How many of `count` requests for `id` on one frame actually start. */
function startsIn(limiter: SoundStartLimiter, id: string, frame: number,
    count: number): number {
    let started = 0;
    for (let i = 0; i < count; i++) {
        if (limiter.allow(id, frame)) {
            started++;
        }
    }
    return started;
}

describe('SoundStartLimiter', () => {
    it('caps same-frame starts of one sound at three', () => {
        // Ten identical escorts firing the same weapon on one frame.
        const limiter = new SoundStartLimiter();
        expect(startsIn(limiter, 'blaster', 1000, 10)).toEqual(3);
        expect(MAX_SAME_SOUND_STARTS_PER_FRAME).toEqual(3);
    });

    it('lets everything through below the cap', () => {
        const limiter = new SoundStartLimiter();
        expect(startsIn(limiter, 'blaster', 1000, 2)).toEqual(2);
    });

    it('counts each sound id separately', () => {
        // A crowded frame is still allowed to be varied: capping one
        // sample must not silence a different one.
        const limiter = new SoundStartLimiter();
        expect(startsIn(limiter, 'blaster', 1000, 10)).toEqual(3);
        expect(startsIn(limiter, 'torpedo', 1000, 10)).toEqual(3);
        expect(startsIn(limiter, 'explosion', 1000, 1)).toEqual(1);
    });

    it('resets on the next frame', () => {
        const limiter = new SoundStartLimiter();
        expect(startsIn(limiter, 'blaster', 1000, 10)).toEqual(3);
        expect(startsIn(limiter, 'blaster', 1016, 10)).toEqual(3);
        expect(startsIn(limiter, 'blaster', 1032, 1)).toEqual(1);
    });

    it('re-arms when the clock moves BACKWARD (rollback)', () => {
        // Any change of frame stamp resets, so a rewound display clock
        // cannot leave the limiter wedged shut.
        const limiter = new SoundStartLimiter();
        expect(startsIn(limiter, 'blaster', 1000, 10)).toEqual(3);
        expect(startsIn(limiter, 'blaster', 900, 10)).toEqual(3);
    });

    it('honours a custom cap', () => {
        expect(startsIn(new SoundStartLimiter(1), 'blaster', 1, 5)).toEqual(1);
        expect(startsIn(new SoundStartLimiter(5), 'blaster', 1, 10)).toEqual(5);
    });

    it('interleaves ids within a frame without leaking counts', () => {
        // Requests do not arrive grouped by id: a b a b ... must still
        // cap each id at three.
        const limiter = new SoundStartLimiter();
        let blasters = 0;
        let torpedoes = 0;
        for (let i = 0; i < 10; i++) {
            if (limiter.allow('blaster', 7)) blasters++;
            if (limiter.allow('torpedo', 7)) torpedoes++;
        }
        expect(blasters).toEqual(3);
        expect(torpedoes).toEqual(3);
    });
});

/**
 * The two defenses compose: the SOURCE dedup collapses a submunition
 * burst to one emission (fire_weapon_plugin's fireSubs), and the mixer
 * cap then trims whatever coincidental pileup remains.
 */
describe('submunition dedup layered with the per-frame cap', () => {
    it('plays a five-child burst once — below the cap, untouched', () => {
        // fireSubs emits ONE sound for the burst, so the limiter, which
        // would have allowed three, never has to intervene. This is why
        // the source dedup is still needed: a cap of 3 alone would let
        // three copies of a single burst through.
        const limiter = new SoundStartLimiter();
        const emissionsFromOneBurst = 1;
        expect(startsIn(limiter, 'torpedo', 100, emissionsFromOneBurst))
            .toEqual(1);
    });

    it('trims six escorts each firing one deduped burst on one frame', () => {
        // Six separate ships, six separate submunition events: the source
        // dedup cannot help (different entities), so the cap does.
        const limiter = new SoundStartLimiter();
        expect(startsIn(limiter, 'torpedo', 100, 6)).toEqual(3);
    });

    it('still sounds every shot of a burst weapon firing over time', () => {
        // N shots on N different frames are N different frames' budgets.
        const limiter = new SoundStartLimiter();
        let started = 0;
        for (let frame = 0; frame < 8; frame++) {
            if (limiter.allow('blaster', frame * 16)) {
                started++;
            }
        }
        expect(started).toEqual(8);
    });
});
