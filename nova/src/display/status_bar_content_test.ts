import 'jasmine';
import { createInitialPlayerState } from '../nova_plugin/player_state';
import {
    formatCargo,
    formatCredits,
    statusBarCargoText,
    boardingOutcomeText,
    statusBarNavigationText,
    statusBarTargetHealth,
    statusBarTargetStatus,
} from './status_bar_content';

describe('status bar content', () => {
    it('formats credits with thousands separators', () => {
        expect(formatCredits(1_234_567)).toEqual('1,234,567');
    });

    it('formats used cargo out of total capacity', () => {
        expect(formatCargo(1_234, 10_000)).toEqual('1,234 / 10,000 tons');
    });

    it('builds cargo content from live player state', () => {
        const state = createInitialPlayerState();
        state.credits = 987_654;
        state.cargoCapacity = 25;
        state.holds = [
            { commodity: 'Food', tons: 3, isMissionCargo: false },
            { commodity: 'Ore', tons: 4, isMissionCargo: false },
        ];

        expect(statusBarCargoText(state)).toEqual({
            free: '18',
            special: undefined,
            credits: '987,654',
        });
    });

    it('shows one deterministic mission cargo name from STR# 4000', () => {
        const state = createInitialPlayerState();
        state.cargoCapacity = 10;
        state.holds = [
            { commodity: 'nova:mission-b', tons: 2, isMissionCargo: true },
            { commodity: 'nova:mission-a', tons: 1, isMissionCargo: true },
            { commodity: 'Food', tons: 3, isMissionCargo: false },
        ];
        state.activeMissions = [
            {
                missionId: 'nova:mission-b',
                state: 'active',
                cargo: { type: 1, quantity: 2 },
            },
            {
                missionId: 'nova:mission-a',
                state: 'active',
                cargo: { type: 0, quantity: 1 },
            },
        ];

        expect(statusBarCargoText(state, ['Passengers', 'Documents']))
            .toEqual({
                free: '4',
                special: 'Documents',
                credits: '10,000',
            });
    });

    it('omits Special when only ordinary cargo is held', () => {
        const state = createInitialPlayerState();
        state.holds = [
            { commodity: 'Food', tons: 1, isMissionCargo: false },
        ];
        expect(statusBarCargoText(state).special).toBeUndefined();
    });

    it('uses the retail disabled target status', () => {
        expect(statusBarTargetStatus(true)).toEqual('Disabled');
        expect(statusBarTargetStatus(false)).toBeUndefined();
    });
});

describe('status bar navigation', () => {
    it('names the plotted first hop', () => {
        expect(statusBarNavigationText(['nova:140'], 'Tichel')).toEqual({
            heading: 'Hyperspace',
            destination: 'Tichel',
        });
    });

    it('shows nothing without a plotted route', () => {
        expect(statusBarNavigationText([], 'Tichel')).toBeUndefined();
    });
});

describe('target health row', () => {
    it('does not retain a percentage without shield or armor', () => {
        expect(statusBarTargetHealth(false)).toEqual({});
    });

    it('prefers shield, then armor', () => {
        expect(statusBarTargetHealth(false, 100, 80)).toEqual({
            label: 'Shield:',
            percent: '100%',
        });
        expect(statusBarTargetHealth(false, 0, 80)).toEqual({
            label: 'Armor:',
            percent: '80%',
        });
    });
});

describe('boardingOutcomeText', () => {
    it('names what was taken', () => {
        expect(boardingOutcomeText(5, 1200))
            .toEqual('Boarded: took 5 tons of cargo and 1,200 cr.');
    });

    it('reports each kind of loot on its own', () => {
        expect(boardingOutcomeText(5, 0)).toEqual('Boarded: took 5 tons of cargo.');
        expect(boardingOutcomeText(0, 30)).toEqual('Boarded: took 30 cr.');
    });

    it('says so when the hull was empty', () => {
        expect(boardingOutcomeText(0, 0))
            .toEqual('Boarded: nothing worth taking.');
    });
});
