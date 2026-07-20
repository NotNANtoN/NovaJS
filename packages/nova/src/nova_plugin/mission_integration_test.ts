import 'jasmine';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import { MissionSession, advanceEntityDate, processEntityLanding } from '../spaceport/mission_session.js';
import { MissionUniverse } from '../spaceport/mission_universe.js';
import { dayNumber, daysPerJump } from './calendar.js';
import { CargoComponent } from './cargo_plugin.js';
import { makeShip } from './make_ship.js';
import {
    acceptOffer,
    LOCATION_BAR,
    LOCATION_MISSION_COMPUTER,
    makeMissionOffer,
    missionMatchesLocation,
} from './mission_logic.js';
import { GOAL_DESTROY } from './mission_ship_state.js';
import { ControlBitsComponent } from './ncb_plugin.js';
import { CombatRatingComponent } from './reputation_plugin.js';
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

    /**
     * nova:657 "Defeat Fellow Initiates" (Auroran 005): destroy 4
     * ships from düde nova:240 in sÿst nova:329, offered in the bar
     * on Heraan (nova:360) to a pilot with bits b204 & b511; return
     * to Heraan; OnSuccess sets b205.
     */
    it('offers a real destroy mission and gates completion on the goal',
        async () => {
            const gameData = await getIntegrationGameData();
            const universe = MissionUniverse.shared(gameData);
            await universe.load();

            const start = await gameData.data.PlayerStart.get('nova:128');
            const shipData = await gameData.data.Ship.get(start.ship);
            const entity = makeShip(shipData);
            entity.components.set(GameDateComponent, { ...start.date });
            entity.components.set(CreditsComponent, { credits: 0 });
            entity.components.set(ControlBitsComponent,
                new Set([204, 511]));
            // nova:657 requires AvailRating 150; give the test pilot
            // enough kill points to qualify (reputations gate offers).
            entity.components.set(CombatRatingComponent, { kills: 150 });

            const session = await MissionSession.create(
                entity, gameData, universe, 'nova:360');
            const mission = universe.getMission('nova:657')!;
            const ctx = session.machinery.offerContext();
            expect(missionMatchesLocation(mission, LOCATION_BAR, ctx))
                .toBe(true);

            const offer = makeMissionOffer(mission, ctx)!;
            expect(offer).not.toBeNull();
            expect(offer.shipObjective).toEqual(jasmine.objectContaining({
                goal: GOAL_DESTROY,
                systemId: 'nova:329',
                dudeId: 'nova:240',
                total: 4,
                satisfied: 0,
                complete: false,
            }));

            acceptOffer(session.machinery, offer, session.outfits);
            session.commit();
            const active = entity.components.get(MissionsComponent)!
                .get('nova:657')!;
            expect(active.shipObjective).toBeDefined();

            // Landing back at Heraan with the goal incomplete must
            // NOT complete the mission.
            let events = await processEntityLanding(
                entity, gameData, universe, 'nova:360');
            expect(events.find(e => e.type === 'completed'))
                .toBeUndefined();
            expect(entity.components.get(MissionsComponent)!
                .has('nova:657')).toBe(true);

            // The shared sim reports all four ships destroyed.
            const objective = entity.components.get(MissionsComponent)!
                .get('nova:657')!.shipObjective!;
            objective.satisfied = 4;
            objective.complete = true;
            objective.shipDonePending = true;

            events = await processEntityLanding(
                entity, gameData, universe, 'nova:360');
            const completed = events.find(e => e.type === 'completed');
            expect(completed).toBeDefined();
            expect(entity.components.get(ControlBitsComponent)!.has(205))
                .toBe(true);
            expect(entity.components.get(MissionsComponent)!.size).toBe(0);
        });

    it('fails a mission whose ship goal failed, at the next landing',
        async () => {
            const gameData = await getIntegrationGameData();
            const universe = MissionUniverse.shared(gameData);
            await universe.load();

            const start = await gameData.data.PlayerStart.get('nova:128');
            const shipData = await gameData.data.Ship.get(start.ship);
            const entity = makeShip(shipData);
            entity.components.set(GameDateComponent, { ...start.date });
            entity.components.set(CreditsComponent, { credits: 0 });
            entity.components.set(ControlBitsComponent,
                new Set([204, 511]));

            const session = await MissionSession.create(
                entity, gameData, universe, 'nova:360');
            const offer = makeMissionOffer(universe.getMission('nova:657')!,
                session.machinery.offerContext())!;
            acceptOffer(session.machinery, offer, session.outfits);
            session.commit();

            entity.components.get(MissionsComponent)!
                .get('nova:657')!.shipObjective!.failed = true;
            const events = await processEntityLanding(
                entity, gameData, universe, 'nova:360');
            expect(events.find(e => e.type === 'failed')).toBeDefined();
            expect(entity.components.get(MissionsComponent)!.size).toBe(0);
        });

    /**
     * nova:155 "Take Sample" (Polaris6a) is a BOARD-goal mission
     * (ShipGoal 2), offered in the bar on nova:286 with bit b279.
     * Boarding does not exist, so it must stay suppressed even when
     * every other condition matches.
     */
    it('still suppresses a real board-goal mission', async () => {
        const gameData = await getIntegrationGameData();
        const universe = MissionUniverse.shared(gameData);
        await universe.load();

        const start = await gameData.data.PlayerStart.get('nova:128');
        const shipData = await gameData.data.Ship.get(start.ship);
        const entity = makeShip(shipData);
        entity.components.set(GameDateComponent, { ...start.date });
        entity.components.set(CreditsComponent, { credits: 0 });
        entity.components.set(ControlBitsComponent, new Set([279]));

        const session = await MissionSession.create(
            entity, gameData, universe, 'nova:286');
        const mission = universe.getMission('nova:155')!;
        expect(mission.shipGoal).toBe(2);
        const ctx = session.machinery.offerContext();
        // Everything else about the mission matches this bar...
        expect(mission.availStelId).toBe('nova:286');
        expect(mission.availLoc).toBe(LOCATION_BAR);
        // ...but the board goal keeps it unofferable.
        expect(missionMatchesLocation(mission, LOCATION_BAR, ctx))
            .toBe(false);
    });

    it('starts a mission from an outfit-style Sxxx set string', async () => {
        // This is the outfitter hook (item 3): a set string run through
        // the session's mission machinery must be able to Sxxx-start a
        // mission, not just flip control bits.
        const gameData = await getIntegrationGameData();
        const universe = MissionUniverse.shared(gameData);
        await universe.load();

        const start = await gameData.data.PlayerStart.get('nova:128');
        const shipData = await gameData.data.Ship.get(start.ship);
        const entity = makeShip(shipData);
        entity.components.set(GameDateComponent, { ...start.date });
        entity.components.set(CreditsComponent, { credits: 0 });
        entity.components.set(ControlBitsComponent, new Set());

        // Docked somewhere inhabited (nova:128 "Delivery to Earth"
        // resolves a return of Earth from any inhabited stellar).
        const dockedAt = universe.stellarCandidates.find(
            s => !s.uninhabited && s.canLand && s.id !== 'nova:128')!;
        const session = await MissionSession.create(
            entity, gameData, universe, dockedAt.id);

        // "S128" — start mission 128 — as an outfit OnPurchase would.
        session.runMissionSet('S128', 'nova');
        session.commit();

        expect(entity.components.get(MissionsComponent)!.has('nova:128'))
            .toBe(true);
    });

    it('fails an in-flight deadline the moment it passes, on jump',
        async () => {
            // Item 1: advanceEntityDate (with game data) fails an expired
            // mission mid-flight and queues the notice for the next
            // landing rather than waiting for the landing to notice.
            const gameData = await getIntegrationGameData();
            const universe = MissionUniverse.shared(gameData);
            await universe.load();

            const start = await gameData.data.PlayerStart.get('nova:128');
            const shipData = await gameData.data.Ship.get(start.ship);
            const entity = makeShip(shipData);
            entity.components.set(GameDateComponent, { ...start.date });
            entity.components.set(CreditsComponent, { credits: 0 });
            entity.components.set(ControlBitsComponent, new Set());

            const dockedAt = universe.stellarCandidates.find(
                s => !s.uninhabited && s.canLand && s.id !== 'nova:128')!;
            const session = await MissionSession.create(
                entity, gameData, universe, dockedAt.id);
            const offer = makeMissionOffer(universe.getMission('nova:128')!,
                session.machinery.offerContext())!;
            acceptOffer(session.machinery, offer, session.outfits);
            // Give it a 1-day deadline so a single jump overruns it.
            session.state.missions.get('nova:128')!.deadlineDay =
                dayNumber(entity.components.get(GameDateComponent)!);
            session.commit();

            // A jump-length date advance (with game data) passes the
            // deadline: the mission fails now, not at the next landing.
            await advanceEntityDate(entity, 3, universe, gameData);
            expect(entity.components.get(MissionsComponent)!.size).toBe(0);

            // The failure notice surfaces at the next landing.
            const events = await processEntityLanding(
                entity, gameData, universe, dockedAt.id);
            expect(events.find(e => e.type === 'failed')?.missionId)
                .toBe('nova:128');
        });
});
