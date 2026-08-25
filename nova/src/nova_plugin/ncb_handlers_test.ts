import { executeSetOperations, parseSetExpression } from './ncb';
import { createNcbHandlers } from './ncb_handlers';
import { createInitialPlayerState } from './player_state';

describe('NCB game handlers', () => {
    it('mutates outfits, ranks, stellar state, and exploration', () => {
        const state = createInitialPlayerState();
        const outfits = new Map([
            ['nova:11', { count: 1 }],
            ['nova:12', { count: 2 }],
        ]);
        const handlers = createNcbHandlers({ state, outfits });

        executeSetOperations(
            parseSetExpression('G11 D12 K4 L5 Y130 U131 X222'),
            state.missionBits,
            { handlers },
        );

        expect(outfits.get('nova:11')?.count).toBe(2);
        expect(outfits.get('nova:12')?.count).toBe(1);
        expect(state.activeRanks).toEqual([4]);
        expect(state.destroyedStellars).toEqual(['nova:130']);
        expect(state.exploredSystems).toEqual(['nova:222']);
    });

    it('applies change-ship outfit semantics and movement', () => {
        const state = createInitialPlayerState();
        const outfits = new Map([
            ['nova:20', { count: 1 }],
            ['nova:21', { count: 1 }],
        ]);
        const defaults = new Map([
            ['nova:200', new Map([['nova:22', { count: 2 }]])],
        ]);
        let movedTo: string | undefined;
        const handlers = createNcbHandlers({
            state,
            outfits,
            shipDefaults: defaults,
            onMoveToSystem: systemId => movedTo = systemId,
        });

        executeSetOperations(
            parseSetExpression('E200 M333'),
            state.missionBits,
            { handlers },
        );

        expect(state.shipId).toBe('nova:200');
        expect(outfits.get('nova:20')?.count).toBe(1);
        expect(outfits.get('nova:22')?.count).toBe(2);
        expect(state.currentSystem).toBe('nova:333');
        expect(movedTo).toBe('nova:333');
    });
});
