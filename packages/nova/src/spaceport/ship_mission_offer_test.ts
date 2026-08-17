import 'jasmine';
import { getDefaultPersData, PersData } from 'novadatainterface/pers_data';
import { getDefaultShipData, ShipData } from 'novadatainterface/ship_data';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import {
    shipOfferConsequence, ShipOfferContext, shipOffers, shipOfferTrigger,
} from './ship_mission_offer.js';

/**
 * ============================================================================
 * Missions offered BY A SHIP (mïsn AvailLoc 2)
 * ============================================================================
 *
 * The Bible: AvailLoc 2 is "Offered from ship (must set up associated
 * përs resource as well)", and përs Flags 0x0200 is "Offer ship's
 * LinkMission when boarding it instead of when hailing it" — so the përs,
 * not the mission, decides which of the two triggers fires.
 */

function pers(overrides: Partial<PersData> = {},
    flags: Partial<PersData['flags']> = {}): PersData {
    const base = getDefaultPersData();
    return {
        ...base, linkMission: 'nova:134', ...overrides,
        flags: { ...base.flags, ...flags },
    };
}

function ctx(overrides: Partial<ShipOfferContext> = {}): ShipOfferContext {
    return {
        trigger: 'hail', disabled: false, attackingPlayer: false,
        holdsGrudge: false, likesPlayer: false, missionAvailable: true,
        playerShip: undefined, ...overrides,
    };
}

const playerShip = (inherentAI: number): ShipData =>
    ({ ...getDefaultShipData(), inherentAI });

describe('shipOfferTrigger (përs Flags 0x0200)', () => {
    it('offers on hailing by default', () => {
        expect(shipOfferTrigger(pers())).toEqual('hail');
    });

    it('offers on boarding when the bit is set', () => {
        expect(shipOfferTrigger(pers({}, { offerMissionOnBoarding: true })))
            .toEqual('board');
    });

    it('offers nothing without a LinkMission', () => {
        expect(shipOfferTrigger(pers({ linkMission: null }))).toBeNull();
    });
});

describe('shipOffers', () => {
    it('makes the offer on its own trigger and no other', () => {
        const boarder = pers({}, { offerMissionOnBoarding: true });
        expect(shipOffers(boarder, ctx({ trigger: 'board' }))).toBeTrue();
        expect(shipOffers(boarder, ctx({ trigger: 'hail' }))).toBeFalse();
        const hailer = pers();
        expect(shipOffers(hailer, ctx({ trigger: 'hail' }))).toBeTrue();
        expect(shipOffers(hailer, ctx({ trigger: 'board' }))).toBeFalse();
    });

    it('stays silent when the mission is not available to the player', () => {
        expect(shipOffers(pers(), ctx({ missionAvailable: false })))
            .toBeFalse();
    });

    it('honours the disabled gate (0x0020) on BOTH triggers', () => {
        // The derelicts that offer on boarding are hulks, so a gate that
        // only ran on hails would let them be skipped entirely.
        const derelict = pers({},
            { offerMissionOnBoarding: true, hailOnlyWhenDisabled: true });
        expect(shipOffers(derelict, ctx({ trigger: 'board', disabled: true })))
            .toBeTrue();
        expect(shipOffers(derelict, ctx({ trigger: 'board', disabled: false })))
            .toBeFalse();
    });

    it('honours the grudge, likes-you and attacking gates', () => {
        expect(shipOffers(pers({}, { hailOnlyWithGrudge: true }), ctx()))
            .toBeFalse();
        expect(shipOffers(pers({}, { hailOnlyWithGrudge: true }),
            ctx({ holdsGrudge: true }))).toBeTrue();
        expect(shipOffers(pers({}, { hailOnlyWhenLikesPlayer: true }), ctx()))
            .toBeFalse();
        expect(shipOffers(pers({}, { hailOnlyWhenAttacking: true }), ctx()))
            .toBeFalse();
        expect(shipOffers(pers({}, { hailOnlyWhenAttacking: true }),
            ctx({ attackingPlayer: true }))).toBeTrue();
    });

    it('keeps a job away from the wrong kind of PLAYER ship', () => {
        // 0x1000/0x2000/0x4000 are about the player's hull, not the
        // përs's: the Bible's way of not offering a courier run to a
        // battleship. AIType 1-2 are its "Freighters", 3+ warships.
        expect(shipOffers(pers({}, { noMissionIfWarship: true }),
            ctx({ playerShip: playerShip(3) }))).toBeFalse();
        expect(shipOffers(pers({}, { noMissionIfWarship: true }),
            ctx({ playerShip: playerShip(1) }))).toBeTrue();
        expect(shipOffers(pers({}, { noMissionIfWimpyTrader: true }),
            ctx({ playerShip: playerShip(1) }))).toBeFalse();
        expect(shipOffers(pers({}, { noMissionIfBeefyTrader: true }),
            ctx({ playerShip: playerShip(2) }))).toBeFalse();
        expect(shipOffers(pers({}, { noMissionIfBeefyTrader: true }),
            ctx({ playerShip: playerShip(1) }))).toBeTrue();
    });
});

describe('shipOfferConsequence', () => {
    it('reports the përs replacement (0x0040) and departure (0x0800)', () => {
        expect(shipOfferConsequence(pers())).toEqual('stay');
        expect(shipOfferConsequence(
            pers({}, { replaceWithSpecialShip: true }))).toEqual('replace');
        expect(shipOfferConsequence(
            pers({}, { leavesAfterMissionAccepted: true }))).toEqual('leave');
        // Replacement wins: both remove the hull, and only one of them
        // says what takes its place.
        expect(shipOfferConsequence(pers({}, {
            replaceWithSpecialShip: true, leavesAfterMissionAccepted: true,
        }))).toEqual('replace');
    });
});

/**
 * The stock data these rules exist for. Pinned against the real game
 * files so a parser or data change shows up here rather than as a mission
 * that silently stops being offered.
 */
describe('the stock ship-offered missions', () => {
    it('offers the derelict missions on BOARDING', async () => {
        const gameData = await getIntegrationGameData();
        // The Drifting Derelicts: përs 155/156 among them, both govt 160
        // ("Derelicts", gövt Flags1 0x0800 "ships start out disabled"),
        // both carrying përs Flags 0x0200.
        const takeUsHome = await gameData.data.Pers.get('nova:155');
        expect(takeUsHome.linkMission).toEqual('nova:134');
        expect(takeUsHome.flags.offerMissionOnBoarding).toBeTrue();
        expect(shipOfferTrigger(takeUsHome)).toEqual('board');

        const decoy = await gameData.data.Pers.get('nova:156');
        expect(decoy.linkMission).toEqual('nova:133');
        expect(decoy.flags.offerMissionOnBoarding).toBeTrue();
        expect(shipOfferTrigger(decoy)).toEqual('board');
    });

    it('makes the Derelict Decoy a real trap (mïsn 133)', async () => {
        const gameData = await getIntegrationGameData();
        const mission = await gameData.data.Mission.get('nova:133');
        // Four pirates, told to attack the player, jumping in from
        // hyperspace: ShipBehav 0 is "always attack the player",
        // ShipStart 1 is "jump in from hyperspace".
        expect(mission.shipCount).toEqual(4);
        expect(mission.shipBehav).toEqual(0);
        expect(mission.shipStart).toEqual(1);
        // AvailLoc 2: offered from a ship.
        expect(mission.availLoc).toEqual(2);
    });

    it('offers the escort-merchant mission on HAILING, replacing the përs '
        + 'with its special ship', async () => {
            // The stock përs Flags 0x0040 case is not a refuel mission at
            // all: it is "Terrapin" (përs 128-154 and friends), which
            // offers mïsn 132 "Escort Merchant to <RST>" when HAILED, and
            // whose ship is then replaced in place by the mission's single
            // special ship — ShipStart 0, as the Bible requires for a
            // replacement, and ShipBehav 1 "protect the player".
            const gameData = await getIntegrationGameData();
            const terrapin = await gameData.data.Pers.get('nova:128');
            expect(terrapin.linkMission).toEqual('nova:132');
            expect(terrapin.flags.offerMissionOnBoarding).toBeFalse();
            expect(shipOfferTrigger(terrapin)).toEqual('hail');
            expect(terrapin.flags.replaceWithSpecialShip).toBeTrue();
            expect(shipOfferConsequence(terrapin)).toEqual('replace');

            const mission = await gameData.data.Mission.get('nova:132');
            expect(mission.availLoc).toEqual(2);
            expect(mission.shipCount).toEqual(1);
            expect(mission.shipStart).toEqual(0);
            expect(mission.shipBehav).toEqual(1);
        });

    it('sends the take-us-home derelict to a real destination (mïsn 134)',
        async () => {
            const gameData = await getIntegrationGameData();
            const mission = await gameData.data.Mission.get('nova:134');
            expect(mission.availLoc).toEqual(2);
            expect(mission.payVal).toEqual(75000);
            // No special ships of its own: the derelict you boarded IS
            // the mission, and the job is to carry its people home.
            expect(mission.shipCount).toBeLessThan(0);
        });
});
