import 'jasmine';
import { getDefaultGovtData, GovtData } from 'novadatainterface/govt_data';
import { govtDispositionTo } from './govt_disposition.js';
import { shipDisposition } from './iff_plugin.js';
import {
    addRecord,
    applyCrime,
    availRatingOk,
    availRecordOk,
    cleanRecords,
    combatRatingName,
    compRewardDelta,
    crimePenalty,
    decodePayVal,
    DEFAULT_DISABLE_PENALTY,
    DEFAULT_KILL_PENALTY,
    initialRecordsFromGovtStatuses,
    LegalRecords,
    recordHostile,
    recordWith,
} from './reputation.js';

function makeGovt(id: string, partial: Partial<GovtData> = {}): GovtData {
    return { ...getDefaultGovtData(), id, ...partial };
}

// A little political landscape: fed (class 1), its ally bureau (allied
// with class 1), its enemy auroran (enemies with class 1), and an
// unrelated bystander.
const fed = makeGovt('nova:128', {
    classes: [1], allies: [0, 12], enemies: [2],
    crimeTol: 10, killPenalty: 6, disablePenalty: 2,
});
const bureau = makeGovt('nova:153', { classes: [0], allies: [1] });
const auroran = makeGovt('nova:129', { classes: [2], enemies: [1] });
const bystander = makeGovt('nova:200', { classes: [9] });
const allGovts: (readonly [string, GovtData])[] = [
    [fed.id, fed], [auroran.id, auroran], [bureau.id, bureau],
    [bystander.id, bystander]];

describe('recordWith / addRecord', () => {
    it('reads absent entries as the govt InitialRec', () => {
        const records: LegalRecords = new Map();
        expect(recordWith(records, 'nova:128', fed)).toBe(0);
        expect(recordWith(records, 'nova:128',
            makeGovt('nova:128', { initialRecord: -25 }))).toBe(-25);
        expect(recordWith(records, 'nova:999')).toBe(0);
    });

    it('materializes entries from InitialRec when adding', () => {
        const records: LegalRecords = new Map();
        const hostile = makeGovt('nova:150', { initialRecord: -10 });
        addRecord(records, hostile.id, hostile, -5);
        expect(records.get('nova:150')).toBe(-15);
    });

    it('clamps to the pilot-file int16 range', () => {
        const records: LegalRecords = new Map([['nova:128', 32760]]);
        addRecord(records, 'nova:128', fed, 100);
        expect(records.get('nova:128')).toBe(32767);
        addRecord(records, 'nova:128', fed, -100000);
        expect(records.get('nova:128')).toBe(-32767);
    });
});

describe('crimePenalty', () => {
    it('uses the govt field when set', () => {
        expect(crimePenalty(fed, 'kill')).toBe(6);
        expect(crimePenalty(fed, 'disable')).toBe(2);
    });

    it('substitutes the engine defaults for zero fields (stock data)', () => {
        const stock = makeGovt('nova:130');
        expect(crimePenalty(stock, 'kill')).toBe(DEFAULT_KILL_PENALTY);
        expect(crimePenalty(stock, 'disable')).toBe(DEFAULT_DISABLE_PENALTY);
    });
});

describe('applyCrime', () => {
    it('penalizes the victim govt and propagates to allies and enemies',
        () => {
            const records: LegalRecords = new Map();
            applyCrime(records, fed, 'kill', allGovts);
            // Full penalty with the wronged govt.
            expect(records.get(fed.id)).toBe(-6);
            // Its ally hates you half as much (truncated)...
            expect(records.get(bureau.id)).toBe(-3);
            // ...its enemy approves by the same amount...
            expect(records.get(auroran.id)).toBe(3);
            // ...and bystanders don't care.
            expect(records.has(bystander.id)).toBe(false);
        });

    it('accumulates across repeated crimes', () => {
        const records: LegalRecords = new Map();
        applyCrime(records, fed, 'kill', allGovts);
        applyCrime(records, fed, 'kill', allGovts);
        expect(records.get(fed.id)).toBe(-12);
        expect(records.get(auroran.id)).toBe(6);
    });

    it('skips propagation when the truncated half is zero', () => {
        const records: LegalRecords = new Map();
        const petty = makeGovt('nova:300', {
            classes: [5], killPenalty: 1,
        });
        const pettyAlly = makeGovt('nova:301', { allies: [5] });
        applyCrime(records, petty, 'kill',
            [[petty.id, petty], [pettyAlly.id, pettyAlly]]);
        expect(records.get(petty.id)).toBe(-1);
        expect(records.has(pettyAlly.id)).toBe(false);
    });
});

describe('recordHostile', () => {
    it('flips exactly below -CrimeTol (the warships-attack rule)', () => {
        expect(recordHostile(-10, 10)).toBe(false);
        expect(recordHostile(-11, 10)).toBe(true);
        expect(recordHostile(0, 10)).toBe(false);
        expect(recordHostile(5, 10)).toBe(false);
    });

    it('treats CrimeTol 0 (and nonsense negatives) as zero tolerance',
        () => {
            expect(recordHostile(-1, 0)).toBe(true);
            expect(recordHostile(0, 0)).toBe(false);
            expect(recordHostile(-1, -5)).toBe(true);
        });
});

describe('cleanRecords', () => {
    it('raises a bad record to 0 and leaves good records alone', () => {
        const records: LegalRecords = new Map([
            [fed.id, -40], [bureau.id, 7]]);
        cleanRecords(records, 'govt', fed, allGovts);
        expect(records.get(fed.id)).toBe(0);
        expect(records.get(bureau.id)).toBe(7);
    });

    it('cleans a negative InitialRec govt that has no entry', () => {
        const hated = makeGovt('nova:150', { initialRecord: -100 });
        const records: LegalRecords = new Map();
        cleanRecords(records, 'govt', hated,
            [[hated.id, hated] as const]);
        expect(records.get('nova:150')).toBe(0);
    });

    it("scope 'allies' cleans the govt and its allies only", () => {
        const records: LegalRecords = new Map([
            [fed.id, -40], [bureau.id, -40], [auroran.id, -40],
            [bystander.id, -40]]);
        cleanRecords(records, 'allies', fed, allGovts);
        expect(records.get(fed.id)).toBe(0);
        expect(records.get(bureau.id)).toBe(0);
        expect(records.get(auroran.id)).toBe(-40);
        expect(records.get(bystander.id)).toBe(-40);
    });

    it("scope 'classmates' cleans govts sharing a class", () => {
        const twin = makeGovt('nova:400', { classes: [1] });
        const records: LegalRecords = new Map([
            [fed.id, -40], [twin.id, -40], [auroran.id, -40]]);
        cleanRecords(records, 'classmates', fed,
            [...allGovts, [twin.id, twin] as const]);
        expect(records.get(fed.id)).toBe(0);
        expect(records.get(twin.id)).toBe(0);
        expect(records.get(auroran.id)).toBe(-40);
    });

    it("scope 'all' cleans everyone (ModType 21 ModVal -1)", () => {
        const records: LegalRecords = new Map([
            [fed.id, -40], [auroran.id, -40]]);
        cleanRecords(records, 'all', undefined, allGovts);
        expect(records.get(fed.id)).toBe(0);
        expect(records.get(auroran.id)).toBe(0);
    });
});

describe('availRecordOk / availRatingOk', () => {
    it('ignores AvailRecord 0', () => {
        expect(availRecordOk(0, -9999)).toBe(true);
    });

    it('requires at least this high for positive values', () => {
        expect(availRecordOk(5, 5)).toBe(true);
        expect(availRecordOk(5, 4)).toBe(false);
    });

    it('requires at least this LOW for negative values', () => {
        expect(availRecordOk(-1, -1)).toBe(true);
        expect(availRecordOk(-1, 0)).toBe(false);
        expect(availRecordOk(-1, -30)).toBe(true);
    });

    it('ignores AvailRating -1 and gates on kill points otherwise', () => {
        expect(availRatingOk(-1, 0)).toBe(true);
        expect(availRatingOk(200, 199)).toBe(false);
        expect(availRatingOk(200, 200)).toBe(true);
        expect(availRatingOk(0, 0)).toBe(true);
    });
});

describe('combatRatingName', () => {
    it('names the Appendix I tiers', () => {
        expect(combatRatingName(0)).toBe('No Ability');
        expect(combatRatingName(1)).toBe('Little Ability');
        expect(combatRatingName(99)).toBe('Little Ability');
        expect(combatRatingName(100)).toBe('Fair Ability');
        expect(combatRatingName(12800)).toBe('Deadly');
        expect(combatRatingName(1_000_000)).toBe('Frightening');
    });
});

describe('decodePayVal', () => {
    it('decodes the documented encodings', () => {
        expect(decodePayVal(0)).toEqual({ type: 'none' });
        expect(decodePayVal(-1)).toEqual({ type: 'none' });
        expect(decodePayVal(15000))
            .toEqual({ type: 'credits', amount: 15000 });
        expect(decodePayVal(-10141)).toEqual({
            type: 'cleanRecord', govtResourceId: 141, scope: 'govt' });
        expect(decodePayVal(-20131)).toEqual({
            type: 'cleanRecord', govtResourceId: 131, scope: 'allies' });
        expect(decodePayVal(-30129)).toEqual({
            type: 'cleanRecord', govtResourceId: 129, scope: 'classmates' });
        expect(decodePayVal(-40005))
            .toEqual({ type: 'takePercent', percent: 5 });
        expect(decodePayVal(-50000))
            .toEqual({ type: 'takeCredits', amount: 0 });
        expect(decodePayVal(-51234))
            .toEqual({ type: 'takeCredits', amount: 1234 });
    });

    it('decodes values outside every range to none', () => {
        expect(decodePayVal(-5000)).toEqual({ type: 'none' });
        expect(decodePayVal(-10500)).toEqual({ type: 'none' });
        expect(decodePayVal(-40100)).toEqual({ type: 'none' });
    });
});

describe('compRewardDelta', () => {
    it('grants the full reward on completion', () => {
        expect(compRewardDelta(4, 'complete')).toBe(4);
    });

    it('costs half (truncated) on failure', () => {
        expect(compRewardDelta(4, 'fail')).toBe(-2);
        expect(compRewardDelta(1, 'fail')).toBe(0);
    });

    it('costs 5x on abort only under the 0x0040 flag', () => {
        expect(compRewardDelta(4, 'abort')).toBe(0);
        expect(compRewardDelta(4, 'abort', true)).toBe(-20);
    });
});

describe('initialRecordsFromGovtStatuses', () => {
    it('applies the status to the govt and its allies, negated for enemies',
        () => {
            const records = initialRecordsFromGovtStatuses(
                [{ govt: fed.id, status: 30 }], allGovts);
            expect(records.get(fed.id)).toBe(30);
            expect(records.get(bureau.id)).toBe(30);
            expect(records.get(auroran.id)).toBe(-30);
            expect(records.has(bystander.id)).toBe(false);
        });

    it('still sets the named govt when it is not in the govt list', () => {
        const records = initialRecordsFromGovtStatuses(
            [{ govt: 'nova:999', status: 12 }], allGovts);
        expect(records.get('nova:999')).toBe(12);
    });
});

describe('criminal hostility: sim disposition (govtDispositionTo)', () => {
    it('flips a neutral govt to enemy exactly below -CrimeTol', () => {
        const atTol: LegalRecords = new Map([[fed.id, -10]]);
        const belowTol: LegalRecords = new Map([[fed.id, -11]]);
        expect(govtDispositionTo(fed, undefined, atTol)).toBe('neutral');
        expect(govtDispositionTo(fed, undefined, belowTol)).toBe('enemy');
    });

    it('leaves ships without records (NPCs) politically judged', () => {
        expect(govtDispositionTo(fed, auroran)).toBe('enemy');
        expect(govtDispositionTo(fed, bureau)).toBe('ally');
        expect(govtDispositionTo(fed, undefined)).toBe('neutral');
    });

    it('never flips a neverAttacksPlayer govt', () => {
        const pacifist = makeGovt('nova:500', { crimeTol: 0 });
        pacifist.flags = { ...pacifist.flags, neverAttacksPlayer: true };
        const criminal: LegalRecords = new Map([[pacifist.id, -9999]]);
        expect(govtDispositionTo(pacifist, undefined, criminal))
            .toBe('neutral');
    });

    it('reads an absent record as the InitialRec', () => {
        const hated = makeGovt('nova:501',
            { crimeTol: 10, initialRecord: -50 });
        expect(govtDispositionTo(hated, undefined, new Map()))
            .toBe('enemy');
    });
});

describe('criminal hostility: display disposition (shipDisposition)', () => {
    it('shows hostile radar/corners below -CrimeTol, same as the sim',
        () => {
            const atTol: LegalRecords = new Map([[fed.id, -10]]);
            const belowTol: LegalRecords = new Map([[fed.id, -11]]);
            expect(shipDisposition(fed, undefined, atTol)).toBe('neutral');
            expect(shipDisposition(fed, undefined, belowTol))
                .toBe('hostile');
        });

    it('a criminal record beats political friendliness', () => {
        // Sharing the Federation's government but wanted by it: the
        // record flip outranks the same-govt friendly rule.
        const criminal: LegalRecords = new Map([[fed.id, -999]]);
        expect(shipDisposition(fed, fed, criminal)).toBe('hostile');
        expect(shipDisposition(fed, fed, new Map())).toBe('friendly');
    });

    it('does not change politics-only calls (no records passed)', () => {
        expect(shipDisposition(fed, auroran)).toBe('hostile');
        expect(shipDisposition(fed, undefined)).toBe('neutral');
    });
});
