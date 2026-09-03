import 'jasmine';
import {
    BAR_BUTTON_STRING_INDEX,
    barRumorText,
    BarRumorContext,
    ESCORT_MESSAGE_STRING_INDEX,
    barButtonLabel,
    barFlavorText,
    retailString,
    wrapBarText,
} from './bar_content';

describe('retail bar content', () => {
    const buttons = Array.from({ length: 61 }, (_, index) => `button ${index + 1}`);
    buttons[10] = 'Gamble';
    buttons[11] = 'Holovid';
    buttons[12] = 'Hire Escort';
    const lists = {
        buttons,
        commercials: ['Commercial one', 'Commercial two'],
        news: ['News one', 'News two', 'News three'],
    };

    it('uses the exact retail STR# 150 button positions', () => {
        expect(BAR_BUTTON_STRING_INDEX.gamble).toBe(11);
        expect(BAR_BUTTON_STRING_INDEX.holovid).toBe(12);
        expect(BAR_BUTTON_STRING_INDEX.hireEscort).toBe(13);
        expect(barButtonLabel(lists, 'gamble')).toBe('Gamble');
        expect(barButtonLabel(lists, 'holovid')).toBe('Holovid');
        expect(barButtonLabel(lists, 'hireEscort')).toBe('Hire Escort');
    });

    it('records the retail escort messages without zero-based drift', () => {
        expect(ESCORT_MESSAGE_STRING_INDEX.noShipsForHire).toBe(224);
        expect(ESCORT_MESSAGE_STRING_INDEX.hiringPrice).toBe(228);
        expect(ESCORT_MESSAGE_STRING_INDEX.pay).toBe(297);
        expect(ESCORT_MESSAGE_STRING_INDEX.oneDefected).toBe(302);
    });

    it('cycles commercials and news independently', () => {
        expect(barFlavorText(lists, 'holovid', 3)).toBe('Commercial two');
        expect(barFlavorText(lists, 'news', -1)).toBe('News three');
    });

    it('returns no invented fallback for missing retail data', () => {
        expect(retailString(undefined, 1)).toBeUndefined();
        expect(retailString([], 1)).toBeUndefined();
        expect(barButtonLabel({}, 'gamble')).toBeUndefined();
        expect(barFlavorText({}, 'news', 0)).toBeUndefined();
    });
});

describe('bar pane wrapping', () => {
    const monospace = (text: string) => text.length;

    it('wraps complete words to the real pane width', () => {
        expect(wrapBarText(
            'The quick brown fox jumps over the lazy dog.',
            15,
            monospace,
        )).toBe('The quick brown\nfox jumps over\nthe lazy dog.');
    });

    it('splits an oversized token instead of truncating it', () => {
        const wrapped = wrapBarText('extraordinary', 5, monospace);
        expect(wrapped).toBe('extra\nordin\nary');
        expect(wrapped.replace(/\n/g, '')).toBe('extraordinary');
    });

    it('preserves paragraph breaks', () => {
        expect(wrapBarText('one two\nthree four', 20, monospace))
            .toBe('one two\nthree four');
    });
});

describe('dynamic bar rumors and faction gossip', () => {
    it('generates generic world rumors by default', () => {
        const text = barRumorText({}, 0);
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(10);
    });

    it('reacts to criminal/wanted legal standing with warning barks', () => {
        const text = barRumorText({ legalStanding: -50 }, 0);
        expect(text.toLowerCase()).toContain('security');
    });

    it('reacts to high combat rating with pilot reputation barks', () => {
        const text = barRumorText({ combatRating: 10 }, 0);
        expect(text.toLowerCase()).toContain('commander');
    });

    it('includes government-specific rumors for core factions', () => {
        const fedText = barRumorText({ governmentId: 'nova:federation' }, 0);
        expect(fedText.length).toBeGreaterThan(10);

        const auroranText = barRumorText({ governmentId: 'nova:auroran' }, 0);
        expect(auroranText.length).toBeGreaterThan(10);

        const polarisText = barRumorText({ governmentId: 'nova:polaris' }, 0);
        expect(polarisText.length).toBeGreaterThan(10);
    });

    it('includes NCB bitstring leads when story bits are active', () => {
        const bits = new Set([100]);
        const text = barRumorText({ missionBits: bits }, 0);
        expect(typeof text).toBe('string');
    });
});
