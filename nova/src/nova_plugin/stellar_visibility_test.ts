import 'jasmine';
import { getDefaultAnimation } from 'novadatainterface/Animation';
import { createInitialPlayerState } from './player_state';
import { isStellarTargetable, stellarPresentation, targetableStellars } from './stellar_visibility';

describe('per-pilot stellar visibility', () => {
    const mine = createInitialPlayerState();
    mine.destroyedStellars = ['nova:200', 'nova:201'];
    const other = createInitialPlayerState();
    const deadAnimation = getDefaultAnimation();

    it('hides or reskins only stellars the local pilot destroyed', () => {
        expect(stellarPresentation(mine, { id: 'nova:200', deadType: -1 })).toBe('hidden');
        expect(stellarPresentation(mine, { id: 'nova:201', deadType: 3, deadAnimation }))
            .toBe('dead');
        // DeadType set but its sprite is missing: hide rather than show alive.
        expect(stellarPresentation(mine, { id: 'nova:201', deadType: 3 })).toBe('hidden');
        expect(stellarPresentation(mine, { id: 'nova:202', deadType: -1 })).toBe('normal');
        // Another pilot in the same room still sees both.
        expect(stellarPresentation(other, { id: 'nova:200', deadType: -1 })).toBe('normal');
        expect(stellarPresentation(undefined, { id: 'nova:200' })).toBe('normal');
    });

    it('excludes the local pilot\'s destroyed stellars from targeting', () => {
        const rows = [['a', 'nova:200'], ['b', 'nova:202'], ['c', '201']] as const;
        expect(targetableStellars(rows, row => row[1], mine).map(row => row[0]))
            .toEqual(['b']);
        expect(targetableStellars(rows, row => row[1], other).length).toBe(3);
        expect(isStellarTargetable(undefined, 'nova:200')).toBeTrue();
    });
});
