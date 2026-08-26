import { getDefaultGovtData, GovtData } from 'novadatainterface/GovtData';
import {
    applyCrime,
    COMBAT_RATING_LADDER,
    combatRating,
    combatRatingIndex,
    isCriminal,
    LEGAL_STATUS_LADDER,
    legalStatus,
    penaltyFor,
    recordFor,
} from './legal_record';

function makeGovt(
    id: string,
    overrides: Partial<GovtData> = {},
): GovtData {
    return {
        ...getDefaultGovtData(),
        id,
        name: id,
        classes: [],
        allies: [],
        enemies: [],
        crimeTolerance: 20,
        initialRecord: 0,
        penalties: {
            smuggling: 5,
            disabling: 10,
            boarding: 15,
            killing: 30,
            shooting: 2,
        },
        ...overrides,
    };
}

describe('legal record status', () => {
    it('reads clean for a pilot with no record', () => {
        expect(legalStatus(0, 20)).toBe('No Record');
    });

    it('walks down the ladder as crimes pile up', () => {
        expect(legalStatus(-5, 20)).toBe('No Convictions');
        expect(legalStatus(-25, 20)).toBe('Minor Offender');
        expect(legalStatus(-45, 20)).toBe('Offender');
    });

    it('walks up the ladder for a good citizen', () => {
        expect(legalStatus(5, 20)).toBe('Citizen');
        expect(legalStatus(25, 20)).toBe('Good Citizen');
    });

    it('scales with how tolerant the government is', () => {
        expect(legalStatus(-30, 100)).toBe('No Convictions');
        expect(legalStatus(-30, 5)).toBe('Fugitive');
    });

    it('never runs off the end of the ladder', () => {
        for (const record of [-10000, -1, 0, 1, 10000]) {
            expect(LEGAL_STATUS_LADDER).toContain(legalStatus(record, 20));
        }
    });

    it('survives a government that forgives nothing', () => {
        expect(legalStatus(-1, 0)).toBe('No Convictions');
    });

    it('hunts the player only past the tolerance', () => {
        expect(isCriminal(-20, 20)).toBeFalse();
        expect(isCriminal(-21, 20)).toBeTrue();
        expect(isCriminal(0, 0)).toBeFalse();
    });
});

describe('combat rating', () => {
    it('starts with no ability', () => {
        expect(combatRating(0)).toBe('No Ability');
    });

    it('needs twice the kills for each rung', () => {
        expect(combatRating(1)).toBe('Little Ability');
        expect(combatRating(2)).toBe('Fair Ability');
        expect(combatRating(4)).toBe('Average Ability');
        expect(combatRating(8)).toBe('Good Ability');
    });

    it('caps at the top of the ladder', () => {
        expect(combatRating(1e9)).toBe('Frightening');
        expect(combatRatingIndex(1e9)).toBe(COMBAT_RATING_LADDER.length - 1);
    });

    it('uses a supplied ladder when the retail strings are loaded', () => {
        expect(combatRating(0, ['Nothing', 'Something'])).toBe('Nothing');
        expect(combatRating(99, ['Nothing', 'Something'])).toBe('Something');
    });
});

describe('applying crimes', () => {
    const federation = makeGovt('nova:128', { classes: [1], enemies: [9] });
    const navy = makeGovt('nova:129', { classes: [2], allies: [1] });
    const pirates = makeGovt('nova:130', { classes: [9], enemies: [1] });
    const governments = new Map([
        [federation.id, federation],
        [navy.id, navy],
        [pirates.id, pirates],
    ]);

    it('charges the victim government its own penalty', () => {
        const records = applyCrime({}, 'killing',
            { victim: federation.id, governments });
        expect(records[federation.id]).toBe(-30);
    });

    it('spreads a share to allies and credits enemies', () => {
        const records = applyCrime({}, 'killing',
            { victim: federation.id, governments });
        expect(records[navy.id]).toBe(-10);
        expect(records[pirates.id]).toBe(10);
    });

    it('accumulates across crimes', () => {
        let records = applyCrime({}, 'shooting',
            { victim: federation.id, governments });
        records = applyCrime(records, 'shooting',
            { victim: federation.id, governments });
        expect(records[federation.id]).toBe(-4);
    });

    it('does nothing when the government does not mind', () => {
        const lenient = makeGovt('nova:140', {
            penalties: {
                smuggling: 0, disabling: 0, boarding: 0, killing: 0,
                shooting: 0,
            },
        });
        const records = applyCrime({ 'nova:140': 7 }, 'killing', {
            victim: lenient.id,
            governments: new Map([[lenient.id, lenient]]),
        });
        expect(records['nova:140']).toBe(7);
    });

    it('does not mutate the records it is given', () => {
        const before = { [federation.id]: -1 };
        applyCrime(before, 'killing', { victim: federation.id, governments });
        expect(before[federation.id]).toBe(-1);
    });

    it('starts from the government\'s initial record', () => {
        const proud = makeGovt('nova:150', { initialRecord: 40 });
        const records = applyCrime({}, 'shooting', {
            victim: proud.id,
            governments: new Map([[proud.id, proud]]),
        });
        expect(records[proud.id]).toBe(38);
    });
});

describe('record lookups', () => {
    it('falls back to the initial record then to zero', () => {
        const govt = makeGovt('nova:128', { initialRecord: 12 });
        expect(recordFor({ 'nova:128': -3 }, 'nova:128', govt)).toBe(-3);
        expect(recordFor({}, 'nova:128', govt)).toBe(12);
        expect(recordFor(undefined, 'nova:128')).toBe(0);
    });

    it('reads a missing penalty table as no penalty', () => {
        expect(penaltyFor(undefined, 'killing')).toBe(0);
        expect(penaltyFor({}, 'killing')).toBe(0);
    });
});
