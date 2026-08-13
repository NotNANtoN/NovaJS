import 'jasmine';
import {
    advanceWeaponFlash, beamActiveFor, latestRealFire,
    shouldShowFiringAnimation, weapDecayAlphaPerSecond,
} from './ship_animation_plugin.js';

/**
 * The shän weapon-glow overlay tracks shots that ACTUALLY left the ship,
 * not the held trigger. `WeaponState.firing` is intent — it stays true
 * while the fire key is down even when nothing can be emitted (a turret
 * or beam turret with no target, an empty point-defense sweep, a dry
 * ammo bin, a weapon mid-reload) — so the glow reads
 * `WeaponState.lastFired`, which WeaponsSystem stamps only on the branch
 * where a shot really spawned, plus the live beam entities.
 */
describe('shouldShowFiringAnimation', () => {
    const ship = 'ship-uuid';
    const otherShip = 'other-ship-uuid';
    const glowWeapon = () => true;
    const noGlowWeapon = () => false;

    // THE BUG: a beam turret with the trigger held but no valid target
    // creates no beam entity and stamps no lastFired, so it must stay
    // dark. Before the real-signal fix this returned true off `firing`.
    it('hides the animation for a held trigger that emitted nothing', () => {
        const shown = shouldShowFiringAnimation(
            ship,
            // Trigger down, but no shot has ever been emitted.
            [['beam-turret', { firing: true } as { lastFired?: number }]],
            glowWeapon,
            []);
        expect(shown).toBeFalse();
    });

    it('hides the animation for a held trigger whose last real shot is '
        + 'already accounted for', () => {
            // The trigger is still down after a shot at t=100 that this
            // graphic already flashed for: no NEW emission, so no glow.
            const shown = shouldShowFiringAnimation(
                ship, [['gun', { lastFired: 100 }]], glowWeapon, [], 100);
            expect(shown).toBeFalse();
        });

    it('pulses when a glow weapon actually emits a shot', () => {
        // lastFired moved past what the graphic saw last frame.
        const shown = shouldShowFiringAnimation(
            ship, [['gun', { lastFired: 200 }]], glowWeapon, [], 100);
        expect(shown).toBeTrue();
    });

    it('pulses on a ship\'s very first real shot', () => {
        const shown = shouldShowFiringAnimation(
            ship, [['gun', { lastFired: 1 }]], glowWeapon, [], undefined);
        expect(shown).toBeTrue();
    });

    it('ignores real shots from weapons without the firing-animation flag',
        () => {
            // wëap Flags2 0x200 clear: this weapon drives no glow overlay
            // however much it actually fires.
            const shown = shouldShowFiringAnimation(
                ship, [['gun', { lastFired: 200 }]], noGlowWeapon, [], 100);
            expect(shown).toBeFalse();
        });

    it('hides the animation when nothing has fired and no beam exists', () => {
        const shown = shouldShowFiringAnimation(
            ship, [['gun', {}]], glowWeapon, []);
        expect(shown).toBeFalse();
    });

    it('shows the animation while a beam from this ship still exists, '
        + 'even after the fire input has stopped', () => {
            // Beams keep emitting for their shot duration after release.
            const shown = shouldShowFiringAnimation(
                ship, [['beam', {}]], noGlowWeapon, [[ship, {}]]);
            expect(shown).toBeTrue();
        });

    it('ignores beams fired by other ships', () => {
        const shown = shouldShowFiringAnimation(
            ship, [['beam', {}]], noGlowWeapon, [[otherShip, {}]]);
        expect(shown).toBeFalse();
    });

    it('still keys off this ship\'s beam among beams from many ships', () => {
        const shown = shouldShowFiringAnimation(
            ship, [], noGlowWeapon,
            [[otherShip, {}], [ship, {}], [otherShip, {}]]);
        expect(shown).toBeTrue();
    });

    it('shows a live beam even for a weapon without the animation flag, '
        + 'and with no shot bookkeeping at all', () => {
            // The beam half is entity-existence, not flag-gated: the beam
            // IS the ship's weapon effect for as long as it is emitted.
            expect(shouldShowFiringAnimation(
                ship, [], noGlowWeapon, [[ship, {}]], 999)).toBeTrue();
        });
});

describe('beamActiveFor', () => {
    it('matches only beams whose source is this ship', () => {
        expect(beamActiveFor('a', [['b', {}], ['a', {}]])).toBeTrue();
        expect(beamActiveFor('a', [['b', {}], ['c', {}]])).toBeFalse();
        expect(beamActiveFor('a', [])).toBeFalse();
    });
});

describe('latestRealFire', () => {
    it('is undefined when no weapon has ever emitted a shot', () => {
        expect(latestRealFire([['gun', {}]], () => true)).toBeUndefined();
    });

    it('is undefined when the only weapon that fired drives no glow', () => {
        expect(latestRealFire([['gun', { lastFired: 5 }]], () => false))
            .toBeUndefined();
    });

    it('takes the most recent shot across several glow weapons', () => {
        expect(latestRealFire(
            [['a', { lastFired: 10 }], ['b', { lastFired: 40 }],
            ['c', { lastFired: 25 }]],
            () => true)).toEqual(40);
    });

    it('ignores non-glow weapons when taking the most recent shot', () => {
        // The turret fired more recently, but only the flagged gun counts.
        expect(latestRealFire(
            [['gun', { lastFired: 10 }], ['turret', { lastFired: 40 }]],
            id => id === 'gun')).toEqual(10);
    });

    it('treats a shot at simulation time 0 as a real shot', () => {
        // Guards a `lastFired ?? 0`-style falsy check creeping back in.
        expect(latestRealFire([['gun', { lastFired: 0 }]], () => true))
            .toEqual(0);
    });
});

/**
 * End-to-end alpha trajectories: the decision above composed with the
 * WeapDecay fade, driven one display frame at a time the way
 * ShipAnimationSystem drives it (including its per-graphic memory of the
 * last shot it drew). PIXI-free, so it runs headless.
 */
describe('weapon glow over time', () => {
    const SHIP = 'ship-uuid';
    const FRAME_S = 1 / 60;

    /** One graphic's glow state, as ShipAnimationSystem keeps it. */
    class Glow {
        alpha = 0;
        lastWeaponFired?: number;
        weaponFireSeen = false;

        constructor(readonly weapDecay: number) { }

        /** Advances one display frame; returns the overlay's alpha. */
        frame(weaponStates: [string, { lastFired?: number }][],
            activeBeams: (readonly [string, unknown])[],
            useFiringAnimation: (id: string) => boolean = () => true) {
            const realFire = latestRealFire(weaponStates, useFiringAnimation);
            const lastSeen = this.weaponFireSeen
                ? this.lastWeaponFired : realFire;
            const firing = shouldShowFiringAnimation(
                SHIP, weaponStates, useFiringAnimation, activeBeams, lastSeen);
            this.lastWeaponFired = realFire;
            this.weaponFireSeen = true;
            this.alpha = advanceWeaponFlash(this.alpha, firing,
                weapDecayAlphaPerSecond(this.weapDecay), FRAME_S);
            return this.alpha;
        }
    }

    it('stays dark for a beam turret held on with no target', () => {
        // The reported bug: trigger down, no target, so beam_plugin's
        // fireFromEntity returns undefined — no beam entity, no lastFired.
        const glow = new Glow(5);
        const held: [string, { lastFired?: number }][] =
            [['beam-turret', { firing: true } as { lastFired?: number }]];
        for (let i = 0; i < 30; i++) {
            expect(glow.frame(held, [])).toEqual(0);
        }
    });

    it('lights while the beam entity exists and decays once it ends', () => {
        const glow = new Glow(50); // 15 alpha/s: full fade in ~1/15 s.
        const states: [string, { lastFired?: number }][] = [['beam', {}]];
        // Beam alive: pinned fully opaque however long it lasts.
        for (let i = 0; i < 10; i++) {
            expect(glow.frame(states, [[SHIP, {}]])).toEqual(1);
        }
        // Beam ends: fades at WeapDecay, not instantly.
        const afterOne = glow.frame(states, []);
        expect(afterOne).toBeCloseTo(1 - 15 * FRAME_S, 10);
        expect(afterOne).toBeGreaterThan(0);
        // ...and reaches fully transparent after 1/15 s (4 frames total).
        glow.frame(states, []);
        glow.frame(states, []);
        expect(glow.frame(states, [])).toEqual(0);
    });

    it('snaps straight off when the beam ends on a WeapDecay 0 ship', () => {
        // The documented instant-off choice; unchanged by the real-signal
        // fix.
        const glow = new Glow(0);
        expect(glow.frame([], [[SHIP, {}]])).toEqual(1);
        expect(glow.frame([], [])).toEqual(0);
    });

    it('pulses once per real shot and decays through the reload gap', () => {
        // A projectile weapon with the trigger HELD: `firing` never drops,
        // but the glow follows the shots, flashing at each emission and
        // fading in between rather than sitting pinned at full alpha.
        const glow = new Glow(50);
        const gun = { lastFired: undefined as number | undefined };
        const states: [string, { lastFired?: number }][] = [['gun', gun]];

        // Mid-reload, nothing emitted yet: dark despite the held trigger.
        expect(glow.frame(states, [])).toEqual(0);

        // A shot lands: full flash.
        gun.lastFired = 1000;
        expect(glow.frame(states, [])).toEqual(1);

        // The reload gap: the SAME lastFired is no longer a new shot, so
        // the overlay fades at WeapDecay instead of staying lit.
        expect(glow.frame(states, [])).toBeCloseTo(1 - 15 * FRAME_S, 10);
        expect(glow.frame(states, [])).toBeCloseTo(1 - 30 * FRAME_S, 10);

        // The next real shot re-flashes it.
        gun.lastFired = 1500;
        expect(glow.frame(states, [])).toEqual(1);

        // And a long silence takes it all the way out and keeps it there.
        for (let i = 0; i < 10; i++) {
            glow.frame(states, []);
        }
        expect(glow.frame(states, [])).toEqual(0);
    });

    it('does not flash for a ship that fired before it came on screen', () => {
        // A graphic's first frame adopts the ship's existing shot clock as
        // its baseline, so entering a system does not light up every NPC
        // that has ever fired.
        const glow = new Glow(5);
        const states: [string, { lastFired?: number }][] =
            [['gun', { lastFired: 12345 }]];
        expect(glow.frame(states, [])).toEqual(0);
        expect(glow.frame(states, [])).toEqual(0);
    });
});
