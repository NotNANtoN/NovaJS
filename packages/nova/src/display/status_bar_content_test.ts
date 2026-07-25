import 'jasmine';
import {
    formatCredits, navReadout, abbreviateCargoName, specialCargoSummary,
    standardCargoIndex, ordinal, formatLongDate, jumpArrivalMessage,
} from './status_bar_content.js';

describe('formatCredits', () => {
    it('comma-groups values under a million', () => {
        expect(formatCredits(546553)).toBe('546,553');
        expect(formatCredits(0)).toBe('0');
        expect(formatCredits(999999)).toBe('999,999');
    });
    it('abbreviates millions and billions to two decimals', () => {
        expect(formatCredits(1810000)).toBe('1.81M');
        expect(formatCredits(2100000)).toBe('2.10M');
        expect(formatCredits(3230000)).toBe('3.23M');
        expect(formatCredits(1_340_000_000)).toBe('1.34B');
    });
    it('never shows negative balances', () => {
        expect(formatCredits(-5)).toBe('0');
    });
});

describe('navReadout', () => {
    it('shows the hyperspace destination when a route is set', () => {
        expect(navReadout('Sanddown', 'Earth'))
            .toEqual({ header: 'Hyperspace', value: 'Sanddown', dim: false });
    });
    it('shows the selected stellar when there is no route', () => {
        expect(navReadout(null, 'Europa'))
            .toEqual({ header: 'Stellar Navigation', value: 'Europa', dim: false });
    });
    it('shows the dim placeholder when nothing is selected', () => {
        expect(navReadout(null, null))
            .toEqual({ header: 'Stellar Navigation', value: 'No Destination', dim: true });
    });
});

describe('cargo helpers', () => {
    it('abbreviates the standard commodities as the original does', () => {
        expect(abbreviateCargoName('Food')).toBe('Food');
        expect(abbreviateCargoName('Industrial')).toBe('Ind');
        expect(abbreviateCargoName('Medical Supplies')).toBe('Med');
        expect(abbreviateCargoName('Luxury Goods')).toBe('LuxG');
        expect(abbreviateCargoName('Metal')).toBe('Met');
        expect(abbreviateCargoName('Equipment')).toBe('Equ');
    });
    it('summarizes special cargo', () => {
        expect(specialCargoSummary([])).toBeNull();
        expect(specialCargoSummary(['Probe'])).toBe('Probe');
        expect(specialCargoSummary(['Probe', 'Files'])).toBe('Multiple');
    });
    it('parses standard cargo keys', () => {
        expect(standardCargoIndex('cargo:3')).toBe(3);
        expect(standardCargoIndex('junk:nova:128')).toBeNull();
        expect(standardCargoIndex('mission:5')).toBeNull();
    });
});

describe('date formatting', () => {
    it('produces English ordinals', () => {
        expect(ordinal(1)).toBe('1st');
        expect(ordinal(2)).toBe('2nd');
        expect(ordinal(3)).toBe('3rd');
        expect(ordinal(11)).toBe('11th');
        expect(ordinal(21)).toBe('21st');
        expect(ordinal(22)).toBe('22nd');
    });
    it('formats the long date with a suffix', () => {
        expect(formatLongDate({ day: 21, month: 11, year: 1177 }, ' NC'))
            .toBe('November 21st, 1177 NC');
    });
    it('composes the arrival message', () => {
        expect(jumpArrivalMessage('Sanddown',
            { day: 21, month: 11, year: 1177 }, ' NC'))
            .toBe('Jumping into the Sanddown system on November 21st, 1177 NC.');
    });
});
