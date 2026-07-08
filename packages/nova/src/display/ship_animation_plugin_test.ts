import 'jasmine';
import { shouldShowFiringAnimation } from './ship_animation_plugin.js';

describe('shouldShowFiringAnimation', () => {
    const ship = 'ship-uuid';
    const otherShip = 'other-ship-uuid';

    it('shows the animation while a firing weapon uses the firing animation', () => {
        const shown = shouldShowFiringAnimation(
            ship,
            [['weapon', { firing: true }]],
            () => true,
            []);
        expect(shown).toBeTrue();
    });

    it('hides the animation for a firing weapon without the firing animation', () => {
        const shown = shouldShowFiringAnimation(
            ship,
            [['weapon', { firing: true }]],
            () => false,
            []);
        expect(shown).toBeFalse();
    });

    it('hides the animation when nothing is firing and no beam exists', () => {
        const shown = shouldShowFiringAnimation(
            ship,
            [['weapon', { firing: false }]],
            () => true,
            []);
        expect(shown).toBeFalse();
    });

    it('shows the animation while a beam from this ship still exists, ' +
        'even after the fire input has stopped', () => {
        // The fire key has been released (firing is false), but the beam this
        // ship emitted is still active.
        const shown = shouldShowFiringAnimation(
            ship,
            [['weapon', { firing: false }]],
            () => false,
            [[ship, {}]]);
        expect(shown).toBeTrue();
    });

    it('ignores beams fired by other ships', () => {
        const shown = shouldShowFiringAnimation(
            ship,
            [['weapon', { firing: false }]],
            () => false,
            [[otherShip, {}]]);
        expect(shown).toBeFalse();
    });

    it('still keys off this ship\'s beam among beams from many ships', () => {
        const shown = shouldShowFiringAnimation(
            ship,
            [],
            () => false,
            [[otherShip, {}], [ship, {}], [otherShip, {}]]);
        expect(shown).toBeTrue();
    });
});
