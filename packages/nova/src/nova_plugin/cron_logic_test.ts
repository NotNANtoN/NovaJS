import 'jasmine';
import { CronData, getDefaultCronData } from 'novadatainterface/cron_data';
import { dayNumber } from './calendar.js';
import { runCronsForDays } from './cron_logic.js';
import { CronStates } from './player_state_plugin.js';

function makeCron(partial: Partial<CronData> = {}): CronData {
    return {
        ...getDefaultCronData(),
        id: 'nova:128',
        name: 'Test Cron',
        random: 100,
        ...partial,
    };
}

const DAY = dayNumber({ day: 23, month: 6, year: 1177 });

describe('runCronsForDays', () => {
    it('runs OnStart and OnEnd together for duration 0', () => {
        const cron = makeCron({ onStart: 'b10', onEnd: 'b11' });
        const bits = new Set<number>();
        const states: CronStates = new Map();
        runCronsForDays([cron], states, bits, DAY, DAY + 1, () => 0);
        expect(bits.has(10)).toBe(true);
        expect(bits.has(11)).toBe(true);
        expect(states.get('nova:128')?.phase).toBe('idle');
    });

    it('waits out PreHoldoff before OnStart', () => {
        const cron = makeCron({ preHoldoff: 3, onStart: 'b10' });
        const bits = new Set<number>();
        const states: CronStates = new Map();
        runCronsForDays([cron], states, bits, DAY, DAY + 1, () => 0);
        expect(bits.has(10)).toBe(false);
        expect(states.get('nova:128')?.phase).toBe('pre');
        // The holdoff expires 3 days after activation (on DAY + 4).
        runCronsForDays([cron], states, bits, DAY + 1, DAY + 4, () => 0);
        expect(bits.has(10)).toBe(true);
        expect(states.get('nova:128')?.phase).toBe('idle');
    });

    it('stays active for Duration days before OnEnd', () => {
        const cron = makeCron({ duration: 5, onStart: 'b10', onEnd: 'b11' });
        const bits = new Set<number>();
        const states: CronStates = new Map();
        runCronsForDays([cron], states, bits, DAY, DAY + 1, () => 0);
        expect(bits.has(10)).toBe(true);
        expect(bits.has(11)).toBe(false);
        expect(states.get('nova:128')?.phase).toBe('active');
        runCronsForDays([cron], states, bits, DAY + 1, DAY + 6, () => 0);
        expect(bits.has(11)).toBe(true);
    });

    it('respects EnableOn against the player bits', () => {
        const cron = makeCron({ enableOn: 'b1', onStart: 'b10' });
        const bits = new Set<number>();
        const states: CronStates = new Map();
        runCronsForDays([cron], states, bits, DAY, DAY + 1, () => 0);
        expect(bits.has(10)).toBe(false);
        bits.add(1);
        runCronsForDays([cron], states, bits, DAY + 1, DAY + 2, () => 0);
        expect(bits.has(10)).toBe(true);
    });

    it('respects the Random daily chance', () => {
        const cron = makeCron({ random: 30, onStart: 'b10' });
        const bits = new Set<number>();
        const states: CronStates = new Map();
        runCronsForDays([cron], states, bits, DAY, DAY + 1, () => 0.5);
        expect(bits.has(10)).toBe(false);
        runCronsForDays([cron], states, bits, DAY + 1, DAY + 2, () => 0.2);
        expect(bits.has(10)).toBe(true);
    });

    it('respects the calendar date range', () => {
        const cron = makeCron({
            firstDay: 1, firstMonth: 7, firstYear: 1177,
            lastDay: 31, lastMonth: 7, lastYear: 1177,
            onStart: 'b10',
        });
        const bits = new Set<number>();
        const states: CronStates = new Map();
        // 23 Jun 1177 is before the range.
        runCronsForDays([cron], states, bits, DAY, DAY + 1, () => 0);
        expect(bits.has(10)).toBe(false);
        // 8 days later it is July.
        runCronsForDays([cron], states, bits, DAY + 1, DAY + 9, () => 0);
        expect(bits.has(10)).toBe(true);
    });

    it('holds off re-activation for PostHoldoff days', () => {
        const cron = makeCron({ postHoldoff: 10, onStart: '^b10' });
        const bits = new Set<number>();
        const states: CronStates = new Map();
        runCronsForDays([cron], states, bits, DAY, DAY + 1, () => 0);
        expect(bits.has(10)).toBe(true);
        // The next 10 days must not toggle the bit again.
        runCronsForDays([cron], states, bits, DAY + 1, DAY + 10, () => 0);
        expect(bits.has(10)).toBe(true);
        // After the holdoff it fires again (toggling the bit off).
        runCronsForDays([cron], states, bits, DAY + 10, DAY + 12, () => 0);
        expect(bits.has(10)).toBe(false);
    });
});
