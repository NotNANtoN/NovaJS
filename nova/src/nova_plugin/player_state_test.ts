import 'jasmine';
import { produce } from 'immer';
import {
    createInitialPlayerState,
    decodePlayerState,
    formatGameDate,
    PersistentPlayerState,
    toPersistentPlayerState,
} from './player_state';

describe('toPersistentPlayerState', () => {
    it('detaches persisted data from a revoked Immer draft', () => {
        let persisted: PersistentPlayerState | undefined;

        produce(createInitialPlayerState(), draft => {
            draft.credits = 12_345;
            draft.activeMissions.push({
                missionId: 'nova:test',
                state: 'active',
            });
            persisted = toPersistentPlayerState(draft);
        });

        expect(persisted?.credits).toBe(12_345);
        expect(persisted?.activeMissions[0].missionId).toBe('nova:test');
        expect(JSON.stringify(persisted)).toContain('nova:test');
    });

    it('preserves an optional pilot death marker', () => {
        const state = createInitialPlayerState();
        state.diedAt = 12_345;

        expect(toPersistentPlayerState(state).diedAt).toBe(12_345);
        expect(toPersistentPlayerState(createInitialPlayerState()).diedAt)
            .toBeUndefined();
    });
});

describe('player state decoding', () => {
    it('rewrites domination entries keyed by planet entity uuid to spöb ids', () => {
        const state = createInitialPlayerState();
        state.dominatedStellars = ['planet nova:128', 'nova:128', 'planet nova:171'];
        const decoded = decodePlayerState(JSON.parse(JSON.stringify(state)));
        if (decoded._tag === 'Left') throw new Error('decode failed');
        expect(decoded.right.dominatedStellars).toEqual(['nova:128', 'nova:171']);
    });

    it('formats dates before the 18 Oct 1177 epoch', () => {
        expect(formatGameDate(0)).toBe('18 October 1177 NC');
        expect(formatGameDate(-117)).toBe('23 June 1177 NC');
    });
});
