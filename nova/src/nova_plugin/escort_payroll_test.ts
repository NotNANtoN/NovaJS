import {
    advanceGameDate,
    chargeEscortPayroll,
    createInitialPlayerState,
    escortPayrollDue,
    PlayerState,
} from './player_state';

function pilotWithEscorts(credits: number, pay: number[]): PlayerState {
    const state = createInitialPlayerState();
    state.credits = credits;
    state.escorts = pay.map((dailyPay, index) => ({
        id: `contract-${index}`,
        shipId: 'nova:133',
        dailyPay,
    }));
    return state;
}

describe('escort payroll', () => {
    it('totals a day of pay and ignores a pilot flying alone', () => {
        expect(escortPayrollDue(pilotWithEscorts(0, [500, 250]))).toEqual(750);
        expect(escortPayrollDue(createInitialPlayerState())).toEqual(0);
    });

    it('takes the day of pay out of credits', () => {
        const state = pilotWithEscorts(10_000, [500, 250]);
        expect(chargeEscortPayroll(state).paid).toEqual(750);
        expect(state.credits).toEqual(9_250);
        expect(state.escorts?.length).toEqual(2);
    });

    it('drops the newest escort the pilot can no longer afford', () => {
        const state = pilotWithEscorts(600, [500, 250]);
        const result = chargeEscortPayroll(state);
        expect(result.dismissed.map(contract => contract.id))
            .toEqual(['contract-1']);
        expect(result.paid).toEqual(500);
        expect(state.credits).toEqual(100);
        expect(state.escorts?.map(contract => contract.id))
            .toEqual(['contract-0']);
    });

    it('lets a broke pilot keep flying with nobody on the payroll', () => {
        const state = pilotWithEscorts(10, [500]);
        expect(chargeEscortPayroll(state).paid).toEqual(0);
        expect(state.credits).toEqual(10);
        expect(state.escorts).toEqual([]);
    });

    it('charges a day of pay for every day that passes', () => {
        const state = pilotWithEscorts(10_000, [100]);
        advanceGameDate(state, 3);
        expect(state.credits).toEqual(9_700);
    });

    it('leaves an escortless pilot untouched as days pass', () => {
        const state = createInitialPlayerState();
        const before = state.credits;
        advanceGameDate(state, 5);
        expect(state.credits).toEqual(before);
    });
});
