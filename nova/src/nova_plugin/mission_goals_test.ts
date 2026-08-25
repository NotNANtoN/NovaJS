import {
    advanceMissionGoal,
    goalIsMet,
    newMissionGoal,
} from './mission_goals';

describe('mission goal progress', () => {
    it('completes destroy and disable goals at their totals', () => {
        let destroy = newMissionGoal(0, 2);
        destroy = advanceMissionGoal(destroy, 'destroyed');
        expect(destroy.completed).toBe(false);
        destroy = advanceMissionGoal(destroy, 'destroyed');
        expect(goalIsMet(destroy)).toBe(true);

        let disable = newMissionGoal(1, 2);
        disable = advanceMissionGoal(disable, 'disabled');
        disable = advanceMissionGoal(disable, 'disabled');
        expect(disable.completed).toBe(true);
    });

    it('completes escort only when the destination is reached safely', () => {
        let escort = newMissionGoal(3, 1);
        escort = advanceMissionGoal(escort, 'escortSafe');
        expect(escort.completed).toBe(true);

        escort = newMissionGoal(3, 1);
        escort = advanceMissionGoal(escort, 'lost');
        escort = advanceMissionGoal(escort, 'escortSafe');
        expect(escort.completed).toBe(false);
    });

    it('completes observe when one ship is seen', () => {
        let observe = newMissionGoal(4, 4);
        observe = advanceMissionGoal(observe, 'observed');
        expect(observe.observed).toBe(1);
        expect(observe.completed).toBe(true);
    });
});
