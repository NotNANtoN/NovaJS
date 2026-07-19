import 'jasmine';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import { MissionSession, advanceEntityDate, processEntityLanding } from '../spaceport/mission_session.js';
import { MissionUniverse } from '../spaceport/mission_universe.js';
import { dayNumber, daysPerJump } from './calendar.js';
import { CargoComponent } from './cargo_plugin.js';
import { makeShip } from './make_ship.js';
import {
    acceptOffer,
    LOCATION_MISSION_COMPUTER,
    makeMissionOffer,
    missionMatchesLocation,
} from './mission_logic.js';
import { ControlBitsComponent } from './ncb_plugin.js';
import {
    CreditsComponent,
    GameDateComponent,
    MissionsComponent,
} from './player_state_plugin.js';

/**
 * Drives a real stock-scenario delivery mission — nova:128 "Delivery
 * to Earth" (a mission-computer random-cargo delivery paying 15,000
 * credits at Earth) — through the real data pipeline and the real
 * mission machinery: offer at an inhabited stellar, accept (cargo
 * loaded, OnAccept run), jump-equivalent date advancement, landing at
 * Earth (completion, payment, cargo removal).
 */
describe('missions against real Nova data', () => {
    it('parses the "Delivery to Earth" mission (nova:128)', async () => {
        const gameData = await getIntegrationGameData();
        const misn = await gameData.data.Mission.get('nova:128');
        expect(misn.name).toContain('Delivery to Earth');
        expect(misn.availLoc).toBe(LOCATION_MISSION_COMPUTER);
        expect(misn.availStel).toBe(-1);       // any inhabited stellar
        expect(misn.returnStel).toBe(128);     // Earth
        expect(misn.returnStelId).toBe('nova:128');
        expect(misn.cargoType).toBe(1000);     // random standard type
        expect(misn.cargoQty).toBe(-5);        // 5 tons ± 50%
        expect(misn.payVal).toBe(15000);
        expect(misn.availBits).toBe('!(b511 | b515) & !b350');
        expect(misn.offerText).toContain('Take <CQ> tons of <CT> to <RST>');
    });

    it('exposes mission, cron, and player-start ids', async () => {
        const gameData = await getIntegrationGameData();
        const ids = await gameData.ids;
        expect(ids.Mission.length).toBeGreaterThan(1000);
        expect(ids.Cron.length).toBeGreaterThan(300);
        expect(ids.PlayerStart).toContain('nova:128');
    });

    it('parses the default chär (nova:128) player start', async () => {
        const gameData = await getIntegrationGameData();
        const start = await gameData.data.PlayerStart.get('nova:128');
        expect(start.credits).toBe(25000);
        expect(start.ship).toBe('nova:128'); // Shuttle
        expect(start.date).toEqual({ day: 23, month: 6, year: 1177 });
        expect(start.isDefault).toBe(true);
        expect(start.systems.length).toBeGreaterThan(0);
    });

    it('runs accept -> jump -> land -> complete end to end', async () => {
        const gameData = await getIntegrationGameData();
        const universe = MissionUniverse.shared(gameData);
        await universe.load();

        // A fresh default pilot in a Shuttle.
        const start = await gameData.data.PlayerStart.get('nova:128');
        const shipData = await gameData.data.Ship.get(start.ship);
        const entity = makeShip(shipData);
        entity.components.set(GameDateComponent, { ...start.date });
        entity.components.set(CreditsComponent, { credits: start.credits });
        entity.components.set(ControlBitsComponent, new Set());

        // Docked somewhere inhabited that isn't Earth.
        const dockedAt = universe.stellarCandidates.find(
            s => !s.uninhabited && s.canLand && s.id !== 'nova:128')!;
        expect(dockedAt).toBeDefined();

        const session = await MissionSession.create(
            entity, gameData, universe, dockedAt.id);
        const mission = universe.getMission('nova:128')!;
        const ctx = session.machinery.offerContext();
        expect(missionMatchesLocation(mission,
            LOCATION_MISSION_COMPUTER, ctx)).toBe(true);

        const maybeOffer = makeMissionOffer(mission, ctx);
        expect(maybeOffer === null).toBe(false);
        const offer = maybeOffer!;
        expect(offer.acceptable).toBe(true);
        expect(offer.returnPlanet).toBe('nova:128');
        expect(offer.cargoQty).toBeGreaterThanOrEqual(3);
        expect(offer.cargoQty).toBeLessThanOrEqual(8);

        acceptOffer(session.machinery, offer, session.outfits);
        session.commit();

        const active = entity.components.get(MissionsComponent)!
            .get('nova:128')!;
        expect(active).toBeDefined();
        expect(active.cargoLoaded).toBe(true);
        expect(entity.components.get(CargoComponent)!
            .get('mission:nova:128')).toBe(offer.cargoQty);

        // The jump to Sol: a Shuttle is under 100 tons, so one day.
        const startDay = dayNumber(
            entity.components.get(GameDateComponent)!);
        expect(daysPerJump(shipData.physics.mass)).toBe(1);
        await advanceEntityDate(entity,
            daysPerJump(shipData.physics.mass), universe);
        expect(dayNumber(entity.components.get(GameDateComponent)!))
            .toBe(startDay + 1);

        // Land on Earth: the mission completes and pays. (Landing
        // advances another day.)
        const creditsBefore =
            entity.components.get(CreditsComponent)!.credits;
        const events = await processEntityLanding(
            entity, gameData, universe, 'nova:128');
        const completed = events.find(e => e.type === 'completed');
        expect(completed).toBeDefined();
        expect(completed!.missionId).toBe('nova:128');
        expect(completed!.payment).toBe(15000);
        expect(entity.components.get(CreditsComponent)!.credits)
            .toBe(creditsBefore + 15000);
        expect(entity.components.get(MissionsComponent)!.size).toBe(0);
        expect(entity.components.get(CargoComponent)!
            .has('mission:nova:128')).toBe(false);
        expect(dayNumber(entity.components.get(GameDateComponent)!))
            .toBe(startDay + 2);
    });
});
