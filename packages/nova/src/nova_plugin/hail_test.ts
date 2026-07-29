import { GovtData, getDefaultGovtData } from 'novadatainterface/govt_data';
import {
    assistIsFree,
    bribeAmount,
    BRIBE_FRACTION,
    BRIBE_FRACTION_LARGE,
    BRIBE_MINIMUM,
    canRequestAssistance,
    greetingText,
    hashString,
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
    it('a neutral-govt ship ATTACKING the player answers with hostility', () => {
        // Behavioral hostility: a ship the player provoked is hostile in the
        // dialog regardless of its politics, and a bribing govt still bargains.
        expect(shipHailResponse(withFlags({ warshipsTakeBribes: true }),
            'neutral', 3, /*attackingPlayer=*/true))
            .toEqual({ kind: 'hostile', canBribe: true });
        expect(shipHailResponse(govt(), 'neutral', 3, true))
            .toEqual({ kind: 'hostile', canBribe: false });
    });
    it('a cantBeHailed ship stays silent even while attacking the player',
        () => {
            expect(shipHailResponse(withFlags({ cantBeHailed: true }),
                'neutral', 3, true)).toEqual({ kind: 'cantHail' });
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
    it('is refused by a neutral-govt ship attacking the player', () => {
        // The assistance exploit: a neutral warship shooting a disabled player
        // must not also offer to fly over and repair them.
        expect(canRequestAssistance({ disposition: 'neutral',
            playerNeedsHelp: true, govt: govt(),
            attackingPlayer: true })).toBe(false);
        // Even a Roadside-Assistance govt refuses while attacking.
        expect(canRequestAssistance({ disposition: 'neutral',
            playerNeedsHelp: true,
            govt: withFlags2({ roadsideAssistance: true }),
            attackingPlayer: true })).toBe(false);
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
    const greetings = ['Alpha', 'Bravo', 'Charlie'];
    it('prefers a pers CommQuote over a govt greeting', () => {
        expect(greetingText({ persCommQuote: 'Hello there!',
            govtGreetings: greetings, govtCommName: 'Fed', talkative: true }))
            .toBe('Hello there!');
    });
    it('picks a real govt greeting when there is no pers quote', () => {
        // seed 4 % 3 = 1 -> the second greeting.
        expect(greetingText({ govtGreetings: greetings, seed: 4,
            talkative: true })).toBe('Bravo');
    });
    it('picks the govt greeting deterministically by seed', () => {
        // Same seed -> same line every time (no Math.random).
        const first = greetingText({ govtGreetings: greetings, seed: 7,
            talkative: true });
        const again = greetingText({ govtGreetings: greetings, seed: 7,
            talkative: true });
        expect(first).toBe(again);
        expect(greetings).toContain(first);
        // A different seed can select a different line (8 % 3 = 2).
        expect(greetingText({ govtGreetings: greetings, seed: 8,
            talkative: true })).toBe('Charlie');
    });
    it('falls back to a synthetic line with no greeting resource', () => {
        expect(greetingText({ govtGreetings: [], govtCommName: 'the Federation',
            talkative: true })).toContain('the Federation');
    });
    it('is empty when the govt is not talkative', () => {
        expect(greetingText({ persCommQuote: 'Hi', talkative: false }))
            .toBe('');
    });
});

describe('hashString', () => {
    it('is stable and deterministic for the same input', () => {
        expect(hashString('abc')).toBe(hashString('abc'));
    });
    it('produces an unsigned 32-bit integer', () => {
        const h = hashString('some-ship-uuid');
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(0xffffffff);
        expect(Number.isInteger(h)).toBeTrue();
    });
    it('differs for different inputs (no trivial collisions)', () => {
        expect(hashString('uuid-a')).not.toBe(hashString('uuid-b'));
    });
});
