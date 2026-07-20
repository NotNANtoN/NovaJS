import 'jasmine';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import {
    applyCrime,
    availRatingOk,
    availRecordOk,
    decodePayVal,
    DEFAULT_KILL_PENALTY,
    LegalRecords,
    recordHostile,
} from './reputation.js';
import { GovtData } from 'novadatainterface/govt_data';

/**
 * Reputation against the REAL Nova game data: pins the stock govts'
 * penalty landscape (all penalty fields are zero in stock data — the
 * engine defaults kick in), the ally/enemy propagation across the
 * real political map, and real missions' AvailRecord/AvailRating/
 * PayVal encodings.
 */
describe('reputation against real Nova data', () => {
    async function allGovts():
        Promise<(readonly [string, GovtData])[]> {
        const gameData = await getIntegrationGameData();
        const ids = [...(await gameData.ids).Govt]
            .filter(id => id.startsWith('nova:')).sort();
        return Promise.all(ids.map(async id =>
            [id, await gameData.data.Govt.get(id)] as const));
    }

    it('stock govts leave every penalty field zero (engine defaults)',
        async () => {
            const gameData = await getIntegrationGameData();
            const fed = await gameData.data.Govt.get('nova:128');
            expect(fed.killPenalty).toBe(0);
            expect(fed.disablePenalty).toBe(0);
            expect(fed.crimeTol).toBe(10);
        });

    it('killing a Federation ship propagates across the real map',
        async () => {
            const govts = await allGovts();
            const fed = govts.find(([id]) => id === 'nova:128')![1];
            const records: LegalRecords = new Map();
            applyCrime(records, fed, 'kill', govts);

            // The Federation itself: the full default penalty.
            expect(records.get('nova:128')).toBe(-DEFAULT_KILL_PENALTY);
            // The Bureau (allies include class 1, the Federation's):
            // hates you half as much.
            expect(records.get('nova:153'))
                .toBe(-Math.trunc(DEFAULT_KILL_PENALTY / 2));
            // The Auroran Empire (enemies include class 1): approves.
            expect(records.get('nova:129'))
                .toBe(Math.trunc(DEFAULT_KILL_PENALTY / 2));
            // The Polaris have no relation to class 1: indifferent.
            expect(records.has('nova:130')).toBe(false);
        });

    it('three Federation kills cross CrimeTol 10 and turn them hostile',
        async () => {
            const govts = await allGovts();
            const fed = govts.find(([id]) => id === 'nova:128')![1];
            const records: LegalRecords = new Map();
            applyCrime(records, fed, 'kill', govts);
            applyCrime(records, fed, 'kill', govts);
            expect(recordHostile(records.get('nova:128')!, fed.crimeTol))
                .toBe(false);
            applyCrime(records, fed, 'kill', govts);
            expect(records.get('nova:128')).toBe(-3 * DEFAULT_KILL_PENALTY);
            expect(recordHostile(records.get('nova:128')!, fed.crimeTol))
                .toBe(true);
        });

    it("pins 'Transport Mu'Randa' (nova:150): AvailRating 200, "
        + 'CompGovt Polaris', async () => {
        const gameData = await getIntegrationGameData();
        const mission = await gameData.data.Mission.get('nova:150');
        expect(mission.availRating).toBe(200);
        expect(availRatingOk(mission.availRating, 199)).toBe(false);
        expect(availRatingOk(mission.availRating, 200)).toBe(true);
        // Completion rewards standing with the Polaris (govt 130).
        expect(mission.compGovt).toBe(130);
        expect(mission.compReward).toBe(1);
    });

    it("pins 'Take Mu'Hari to Port Kane' (nova:163): AvailRecord 30",
        async () => {
            const gameData = await getIntegrationGameData();
            const mission = await gameData.data.Mission.get('nova:163');
            expect(mission.availRecord).toBe(30);
            expect(availRecordOk(mission.availRecord, 29)).toBe(false);
            expect(availRecordOk(mission.availRecord, 30)).toBe(true);
        });

    it("pins 'Infiltrate the Rebels' (nova:131): PayVal cleans govt 141",
        async () => {
            const gameData = await getIntegrationGameData();
            const mission = await gameData.data.Mission.get('nova:131');
            expect(mission.payVal).toBe(-10141);
            expect(decodePayVal(mission.payVal)).toEqual({
                type: 'cleanRecord', govtResourceId: 141, scope: 'govt',
            });
        });

    it("pins 'Distract Moash House' (nova:196): PayVal cleans allies",
        async () => {
            const gameData = await getIntegrationGameData();
            const mission = await gameData.data.Mission.get('nova:196');
            expect(mission.payVal).toBe(-20131);
            expect(decodePayVal(mission.payVal)).toEqual({
                type: 'cleanRecord', govtResourceId: 131, scope: 'allies',
            });
        });
});
