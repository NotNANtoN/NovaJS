import 'jasmine';
import { getDefaultGovtData } from 'novadatainterface/GovtData';
import { hailRelation } from './comms';
import { GovernmentData, GovernmentFlags } from './govt_relations';
import { describeHail } from './hail_target';

function govt(over: Partial<GovernmentData> = {}): GovernmentData {
    return { ...getDefaultGovtData(), id: 'nova:150', name: 'Federation',
        crimeTolerance: 6, ...over } as GovernmentData;
}

describe('how a hailed ship regards the pilot', () => {
    it('is hostile while its guns are on the pilot', () => {
        expect(hailRelation({
            record: 100, crimeTolerance: 6, hostile: true,
        })).toBe('enemy');
    });

    it('is hostile once the record passes the tolerance', () => {
        expect(hailRelation({
            record: -7, crimeTolerance: 6, hostile: false,
        })).toBe('enemy');
        expect(hailRelation({
            record: -6, crimeTolerance: 6, hostile: false,
        })).toBe('neutral');
    });

    it('is friendly to a pilot in good standing', () => {
        expect(hailRelation({
            record: 5, crimeTolerance: 6, hostile: false,
        })).toBe('ally');
    });

    it('is indifferent to an unknown pilot', () => {
        expect(hailRelation({
            record: 0, crimeTolerance: 6, hostile: false,
        })).toBe('neutral');
    });
});

describe('describing a hail', () => {
    it('reads the pilot\'s record with that government', () => {
        const description = describeHail(
            { name: 'Patrol Ship', government: govt(), targetingPlayer: false },
            { 'nova:150': 12 });
        expect(description.record).toBe(12);
        expect(description.relation).toBe('ally');
        expect(description.hostile).toBeFalse();
    });

    it('treats a ship with no government as a stranger', () => {
        const description = describeHail(
            { name: 'Drone', targetingPlayer: false }, {});
        expect(description.relation).toBe('neutral');
        expect(description.record).toBe(0);
    });

    it('is an enemy to a xenophobe regardless of record', () => {
        const description = describeHail({
            name: 'Wraith',
            government: govt({ flags: GovernmentFlags.xenophobic }),
            targetingPlayer: false,
        }, { 'nova:150': 50 });
        expect(description.relation).toBe('enemy');
    });

    it('marks a ship shooting at the pilot as hostile', () => {
        const description = describeHail(
            { name: 'Pirate', government: govt(), targetingPlayer: true }, {});
        expect(description.hostile).toBeTrue();
        expect(description.relation).toBe('enemy');
    });

    it('exposes the government roadside-assistance promise', () => {
        const description = describeHail({
            name: 'Vell-os Dart',
            government: govt({ flags2: 0x0032 }),
            targetingPlayer: false,
        }, {});
        expect(description.roadsideAssistance).toBeTrue();
    });
});
