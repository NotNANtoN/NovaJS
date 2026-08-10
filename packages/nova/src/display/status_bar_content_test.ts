import 'jasmine';
import {
    formatCredits, navReadout, abbreviateCargoName, specialCargoSummary,
    standardCargoIndex, ordinal, formatLongDate, jumpArrivalMessage,
    landingBlockedMessage, bayCaptureMessage, targetGovtLabel,
    ESCORT_GOVT_LABEL,
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

describe('landingBlockedMessage', () => {
    it('matches the original planet strings', () => {
        expect(landingBlockedMessage('tooFar', false))
            .toBe("You're too far away to land on this planet.");
        expect(landingBlockedMessage('tooFast', false))
            .toBe("You're moving too fast to land on this planet.");
    });
    it('says "dock at this station" for stations', () => {
        expect(landingBlockedMessage('tooFar', true))
            .toBe("You're too far away to dock at this station.");
        expect(landingBlockedMessage('tooFast', true))
            .toBe("You're moving too fast to dock at this station.");
    });
});

describe('bayCaptureMessage', () => {
    it('names the captured ship class', () => {
        expect(bayCaptureMessage('Viper'))
            .toBe('Captured the Viper into your fighter bay.');
    });
    it('falls back when the ship name is not available', () => {
        // The bay capture opens no dialog, so this line is the player's
        // only notice: it must still say something with a cold cache.
        expect(bayCaptureMessage(undefined))
            .toBe('Captured the ship into your fighter bay.');
    });
});

/**
 * Matthew's item 4: the target pane's government line reads "Escort" for
 * the local player's own escorts. A PER-PLAYER tag, so it is decided
 * display-side from who is looking, never stored in the simulation.
 */
describe('targetGovtLabel', () => {
    const ME = 'my-ship';
    const PEER = 'their-ship';

    it('shows the real government for an ordinary ship', () => {
        expect(targetGovtLabel('Fed.', undefined, ME)).toBe('Fed.');
    });

    it('shows "Escort" for a ship escorting the local player', () => {
        expect(targetGovtLabel('Fed.', ME, ME)).toBe(ESCORT_GOVT_LABEL);
        expect(ESCORT_GOVT_LABEL).toBe('Escort');
    });

    it("shows the real government for ANOTHER player's escort", () => {
        // The per-player half: a peer targeting my escort still sees the
        // government, because the tag depends on who is looking.
        expect(targetGovtLabel('Pyro', PEER, ME)).toBe('Pyro');
    });

    it('still says "Escort" for a DISABLED escort', () => {
        // Nothing here consults DisabledComponent: a disabled escort
        // rejoins the normal target cycle, so this case comes up often,
        // and the ship is still yours.
        expect(targetGovtLabel('Fed.', ME, ME)).toBe(ESCORT_GOVT_LABEL);
    });

    it('falls through when the local player uuid is unknown', () => {
        // Docked or mid-jump: no local ship to compare against.
        expect(targetGovtLabel('Fed.', ME, undefined)).toBe('Fed.');
    });

    it('keeps an empty government empty for a non-escort', () => {
        // The govt data has not cached yet; the pane hides the line.
        expect(targetGovtLabel('', undefined, ME)).toBe('');
    });

    it('tags an escort even before its government data caches', () => {
        expect(targetGovtLabel('', ME, ME)).toBe(ESCORT_GOVT_LABEL);
    });
});
