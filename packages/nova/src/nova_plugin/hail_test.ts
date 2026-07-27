import { GovtData, getDefaultGovtData } from 'novadatainterface/govt_data';
import {
    assistIsFree,
    bribeAmount,
    BRIBE_FRACTION,
    BRIBE_FRACTION_LARGE,
    BRIBE_MINIMUM,
    canRequestAssistance,
    greetingText,
    planetTakesBribes,
    shipHailResponse,
    shipTakesBribes,
} from './hail.js';

function govt(overrides: Partial<GovtData> = {}): GovtData {
    return { ...getDefaultGovtData(), id: 'nova:128', ...overrides };
}
function withFlags(flags: Partial<GovtData['flags']>): GovtData {
    return govt({ flags: { ...getDefaultGovtData().flags, ...flags } });
}
function withFlags2(flags2: Partial<GovtData['flags2']>): GovtData {
    return govt({ flags2: { ...getDefaultGovtData().flags2, ...flags2 } });
}

describe('shipTakesBribes', () => {
    it('warships take bribes only with the warship flag', () => {
        expect(shipTakesBribes(withFlags({ warshipsTakeBribes: true }), 3))
            .toBe(true);
        expect(shipTakesBribes(withFlags({ warshipsTakeBribes: false }), 3))
            .toBe(false);
    });
    it('freighters take bribes only with the freighter flag', () => {
        expect(shipTakesBribes(withFlags({ freightersTakeBribes: true }), 1))
            .toBe(true);
        expect(shipTakesBribes(withFlags({ warshipsTakeBribes: true }), 2))
            .toBe(false);
    });
    it('largerBribes (pirates) always take bribes regardless of aiType', () => {
        expect(shipTakesBribes(withFlags({ largerBribes: true }), 1)).toBe(true);
        expect(shipTakesBribes(withFlags({ largerBribes: true }), 3)).toBe(true);
    });
    it('no govt never takes bribes', () => {
        expect(shipTakesBribes(undefined, 3)).toBe(false);
    });
});

describe('bribeAmount', () => {
    it('demands the ordinary fraction of cash', () => {
        expect(bribeAmount(100_000, false))
            .toBe(Math.floor(100_000 * BRIBE_FRACTION));
    });
    it('demands the larger fraction for pirate govts', () => {
        expect(bribeAmount(100_000, true))
            .toBe(Math.floor(100_000 * BRIBE_FRACTION_LARGE));
    });
    it('never falls below the minimum but never exceeds the player cash', () => {
        expect(bribeAmount(1000, false)).toBe(BRIBE_MINIMUM);
        // A player poorer than the minimum pays everything they have.
        expect(bribeAmount(200, false)).toBe(200);
    });
    it('is deterministic: same inputs, same output (no randomness)', () => {
        expect(bribeAmount(54_321, true)).toBe(bribeAmount(54_321, true));
    });
});

describe('shipHailResponse', () => {
    it('cantBeHailed govts do not answer', () => {
        expect(shipHailResponse(withFlags({ cantBeHailed: true }),
            'neutral', 3)).toEqual({ kind: 'cantHail' });
    });
    it('hostile ship offers a bribe when the govt bargains', () => {
        expect(shipHailResponse(withFlags({ warshipsTakeBribes: true }),
            'hostile', 3)).toEqual({ kind: 'hostile', canBribe: true });
    });
    it('hostile ship of a non-bribing govt offers no bribe', () => {
        expect(shipHailResponse(govt(), 'hostile', 3))
            .toEqual({ kind: 'hostile', canBribe: false });
    });
    it('noAssistOrMercy suppresses the bribe option even for a bribing govt',
        () => {
            const g = withFlags({ warshipsTakeBribes: true });
            g.flags2 = { ...g.flags2, noAssistOrMercy: true };
            expect(shipHailResponse(g, 'hostile', 3))
                .toEqual({ kind: 'hostile', canBribe: false });
        });
    it('friendly / neutral ships greet and are talkative by default', () => {
        expect(shipHailResponse(govt(), 'friendly', 3))
            .toEqual({ kind: 'greeting', talkative: true });
        expect(shipHailResponse(govt(), 'neutral', 1))
            .toEqual({ kind: 'greeting', talkative: true });
    });
    it('noDistressMessages govts answer but are not talkative', () => {
        expect(shipHailResponse(withFlags2({ noDistressMessages: true }),
            'neutral', 3)).toEqual({ kind: 'greeting', talkative: false });
    });
    it('a govt-less ship greets talkatively', () => {
        expect(shipHailResponse(undefined, 'neutral', undefined))
            .toEqual({ kind: 'greeting', talkative: true });
    });
});

describe('canRequestAssistance', () => {
    it('requires the player to actually need help', () => {
        expect(canRequestAssistance({ disposition: 'neutral',
            playerNeedsHelp: false, govt: govt() })).toBe(false);
        expect(canRequestAssistance({ disposition: 'neutral',
            playerNeedsHelp: true, govt: govt() })).toBe(true);
    });
    it('is refused by hostile ships', () => {
        expect(canRequestAssistance({ disposition: 'hostile',
            playerNeedsHelp: true, govt: govt() })).toBe(false);
    });
    it('is refused by noAssistOrMercy / cantBeHailed govts', () => {
        expect(canRequestAssistance({ disposition: 'neutral',
            playerNeedsHelp: true,
            govt: withFlags2({ noAssistOrMercy: true }) })).toBe(false);
        expect(canRequestAssistance({ disposition: 'friendly',
            playerNeedsHelp: true,
            govt: withFlags({ cantBeHailed: true }) })).toBe(false);
    });
    it('is allowed for Roadside Assistance govts when the player needs help',
        () => {
            expect(canRequestAssistance({ disposition: 'neutral',
                playerNeedsHelp: true,
                govt: withFlags2({ roadsideAssistance: true }) })).toBe(true);
        });
});

describe('assistIsFree', () => {
    it('is free for Roadside Assistance govts', () => {
        expect(assistIsFree(withFlags2({ roadsideAssistance: true })))
            .toBe(true);
    });
    it('is not (yet) free otherwise', () => {
        expect(assistIsFree(govt())).toBe(false);
        expect(assistIsFree(undefined)).toBe(false);
    });
});

describe('planetTakesBribes', () => {
    it('honors planetsTakeBribes and largerBribes', () => {
        expect(planetTakesBribes(withFlags({ planetsTakeBribes: true })))
            .toBe(true);
        expect(planetTakesBribes(withFlags({ largerBribes: true }))).toBe(true);
        expect(planetTakesBribes(govt())).toBe(false);
        expect(planetTakesBribes(undefined)).toBe(false);
    });
});

describe('greetingText', () => {
    it('prefers a pers CommQuote', () => {
        expect(greetingText({ persCommQuote: 'Hello there!',
            govtCommName: 'Fed', talkative: true })).toBe('Hello there!');
    });
    it('synthesizes a govt line when there is no pers quote', () => {
        expect(greetingText({ govtCommName: 'the Federation',
            talkative: true })).toContain('the Federation');
    });
    it('is empty when the govt is not talkative', () => {
        expect(greetingText({ persCommQuote: 'Hi', talkative: false }))
            .toBe('');
    });
});
