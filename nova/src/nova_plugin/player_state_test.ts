import 'jasmine';
import produce from 'immer';
import {
    createInitialPlayerState,
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
});
