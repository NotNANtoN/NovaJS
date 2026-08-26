import 'jasmine';
import { createInitialPlayerState } from '../nova_plugin/player_state';
import {
    formatCargo,
    formatCredits,
    statusBarCargoText,
    boardingOutcomeText,
    statusBarTargetStatus,
} from './status_bar_content';

describe('status bar content', () => {
    it('formats credits with thousands separators', () => {
        expect(formatCredits(1_234_567)).toEqual('1,234,567 cr');
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
            credits: '987,654 cr',
            cargo: '7 / 25 tons',
        });
    });

    it('uses the retail disabled target status', () => {
        expect(statusBarTargetStatus(true)).toEqual('Disabled');
        expect(statusBarTargetStatus(false)).toBeUndefined();
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
