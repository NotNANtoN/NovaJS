import 'jasmine';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import {
    applyCrime,
    availRatingOk,
    availRecordOk,
    crimePenalty,
    decodePayVal,
    DEFAULT_BOARD_PENALTY,
    DEFAULT_DISABLE_PENALTY,
    DEFAULT_KILL_PENALTY,
    LegalRecords,
    recordHostile,
} from './reputation.js';
import { GovtData } from 'novadatainterface/govt_data';

/**
 * Reputation against the REAL Nova game data: pins the stock govts'
 * penalty landscape, the ally/enemy propagation across the real
 * political map, and real missions' AvailRecord/AvailRating/PayVal
 * encodings.
 *
 * NOTE: these tests parse base "Nova Files" only. An earlier version
 * of this suite claimed stock gövts leave every penalty field zero —
 * that was an artifact of a plug-in overwriting the stock gövts. Real
 * stock data sets them: 57 of the 68 stock gövts carry a non-zero
 * KillPenalty. The DEFAULT_* engine fallbacks still matter for the 11
 * that leave them at zero (pinned below).
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

    it('pins the stock Federation gövt penalty fields', async () => {
        const gameData = await getIntegrationGameData();
        const fed = await gameData.data.Govt.get('nova:128');
        expect(fed.killPenalty).toBe(5);
        expect(fed.disablePenalty).toBe(1);
        expect(fed.boardPenalty).toBe(2);
        expect(fed.crimeTol).toBe(6);
        // Set fields are used as written, not replaced by defaults.
        expect(crimePenalty(fed, 'kill')).toBe(5);
        expect(crimePenalty(fed, 'disable')).toBe(1);
        expect(crimePenalty(fed, 'board')).toBe(2);
    });

    it('most stock govts set their own penalties', async () => {
        const govts = await allGovts();
        expect(govts.length).toBe(68);
        const withKillPenalty =
            govts.filter(([, g]) => g.killPenalty !== 0);
        expect(withKillPenalty.length).toBe(57);
        // The Vell-os are the harshest in stock data.
        const vellos = govts.find(([id]) => id === 'nova:136')![1];
        expect(vellos.killPenalty).toBe(40);
    });

    it('falls back to the engine defaults for the govts that leave '
        + 'their fields zero', async () => {
            const gameData = await getIntegrationGameData();
            // nova:171 (Spanner) is one of the 11 stock govts with no
            // penalties of its own, so the DEFAULT_* constants apply.
            const spanner = await gameData.data.Govt.get('nova:171');
            expect(spanner.name).toBe('Spanner');
            expect(spanner.killPenalty).toBe(0);
            expect(spanner.disablePenalty).toBe(0);
            expect(spanner.boardPenalty).toBe(0);
            expect(crimePenalty(spanner, 'kill')).toBe(DEFAULT_KILL_PENALTY);
            expect(crimePenalty(spanner, 'disable'))
                .toBe(DEFAULT_DISABLE_PENALTY);
            expect(crimePenalty(spanner, 'board'))
                .toBe(DEFAULT_BOARD_PENALTY);
        });

    it('killing a Federation ship propagates across the real map',
        async () => {
            const govts = await allGovts();
            const fed = govts.find(([id]) => id === 'nova:128')![1];
            const records: LegalRecords = new Map();
            applyCrime(records, fed, 'kill', govts);

            // The Federation's OWN KillPenalty (5), not the engine
            // default — the two happen to be the same number, so pin
            // the source explicitly.
            expect(fed.killPenalty).toBe(5);
            expect(records.get('nova:128')).toBe(-fed.killPenalty);
            // The Bureau (allies include class 1, the Federation's):
            // hates you half as much.
            expect(records.get('nova:153'))
                .toBe(-Math.trunc(fed.killPenalty / 2));
            // The Auroran Empire (enemies include class 1): approves.
            expect(records.get('nova:129'))
                .toBe(Math.trunc(fed.killPenalty / 2));
            // The Polaris have no relation to class 1: indifferent.
            expect(records.has('nova:130')).toBe(false);
        });

    it('two Federation kills cross CrimeTol 6 and turn them hostile',
        async () => {
            const govts = await allGovts();
            const fed = govts.find(([id]) => id === 'nova:128')![1];
            // Stock: KillPenalty 5 against CrimeTol 6, so one kill
            // (-5) is tolerated and the second (-10) is not.
            expect(fed.killPenalty).toBe(5);
            expect(fed.crimeTol).toBe(6);

            const records: LegalRecords = new Map();
            applyCrime(records, fed, 'kill', govts);
            expect(records.get('nova:128')).toBe(-5);
            expect(recordHostile(records.get('nova:128')!, fed.crimeTol))
                .toBe(false);

            applyCrime(records, fed, 'kill', govts);
            expect(records.get('nova:128')).toBe(-10);
            expect(recordHostile(records.get('nova:128')!, fed.crimeTol))
                .toBe(true);
        });

    it('the Vell-os turn hostile on the very first kill (KillPenalty 40 '
        + 'vs CrimeTol 9)', async () => {
            const govts = await allGovts();
            const vellos = govts.find(([id]) => id === 'nova:136')![1];
            expect(vellos.killPenalty).toBe(40);
            expect(vellos.crimeTol).toBe(9);

            const records: LegalRecords = new Map();
            applyCrime(records, vellos, 'kill', govts);
            expect(records.get('nova:136')).toBe(-40);
            expect(recordHostile(records.get('nova:136')!, vellos.crimeTol))
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
