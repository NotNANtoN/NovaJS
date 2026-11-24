import 'jasmine';
import { NovaDataType } from 'novadatainterface/NovaDataInterface';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { MissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import { hasRetailData, retailDataPath, skipWithoutRetailData } from '../../../test/retail_data';
import { sameResourceId } from '../common/resource_id';
import { visibleGalaxy } from './system_variants';
import { getOfferableMissions, MissionAvailabilityInput } from './mission_availability';
import { acceptMission, MissionRuntime, startPendingNcbMissions } from './mission_plugin';
import type { MissionGoalEvent } from './mission_goals';
import {
    createInitialPlayerState,
    PlayerState,
    toPersistentPlayerState,
} from './player_state';
import { makePlayerData } from './player_data_projection';
import type { GovernmentRelation, StellarPlanet, StellarSystem } from './stellar_selector';

/**
 * Walks real mïsn chains through availability, accept and landing with the
 * parsed retail galaxy, so a data-shape or rule regression that strands a
 * storyline shows up as the exact mission that stopped being offered.
 */
describe('retail storylines', () => {
    let gameData: GameDataInterface;
    let missions: Map<string, MissionData>;
    let systems: (StellarSystem & { name?: string, position?: unknown, visibility?: string })[];
    let planets: StellarPlanet[];
    let governments: GovernmentRelation[];

    beforeAll(async () => {
        if (!hasRetailData()) return;
        const { NovaParse } = await import('../../../novaparse/NovaParse');
        const parser = new NovaParse(retailDataPath(), false);
        const ids = await parser.ids;
        gameData = { data: parser.data, ids: parser.ids } as unknown as GameDataInterface;
        missions = new Map();
        for (const id of ids.Mission ?? []) {
            missions.set(id, await parser.data[NovaDataType.Mission].get(id));
        }
        const rawSystems = await Promise.all(ids.System.map(id =>
            parser.data[NovaDataType.System].get(id)));
        systems = rawSystems as never;
        const rawPlanets = await Promise.all(ids.Planet.map(id =>
            parser.data[NovaDataType.Planet].get(id)));
        planets = rawPlanets.map(planet => ({
            id: planet.id,
            inhabited: planet.inhabited,
            government: planet.government,
            systemId: rawSystems.find(system =>
                system.planets.some(id => sameResourceId(id, planet.id)))?.id,
        }));
        governments = await Promise.all((ids.Govt ?? []).map(id =>
            parser.data[NovaDataType.Govt]!.get(id)));
    }, 300000);

    function offerable(
        state: PlayerState,
        planetId: string,
        offerLocation: MissionOfferLocation,
        extra: Partial<MissionAvailabilityInput> = {},
    ): string[] {
        const galaxy = visibleGalaxy(systems, planets, state.missionBits);
        const currentPlanet = galaxy.planets.find(planet => sameResourceId(planet.id, planetId))
            ?? planets.find(planet => sameResourceId(planet.id, planetId))!;
        const currentSystem = galaxy.systems.find(system =>
            sameResourceId(system.id, currentPlanet.systemId))!;
        state.currentSystem = currentSystem.id;
        return getOfferableMissions({
            missionIds: [...missions.keys()],
            missions,
            playerState: state,
            currentPlanet,
            currentSystem,
            offerLocation,
            destinationPlanets: galaxy.planets,
            destinationSystems: galaxy.systems,
            governments,
            random: () => 0,
            ...extra,
        }).map(mission => mission.id);
    }

    function accept(state: PlayerState, id: string, planetId: string) {
        const galaxy = visibleGalaxy(systems, planets, state.missionBits);
        const entry = acceptMission(state, missions.get(id)!, {
            initialPlanetId: planetId,
            planets: galaxy.planets,
            systems: galaxy.systems,
            governments,
            initialSystemId: state.currentSystem,
            currentSystemId: state.currentSystem,
            random: () => 0,
        });
        expect(entry).withContext(`accept ${id}`).toBeDefined();
        return entry!;
    }

    it('walks the tutorial chain 251 -> 630 -> 631 -> 632 -> 633 -> 754', async () => {
        if (skipWithoutRetailData()) return;
        const runtime = new MissionRuntime(gameData);
        const state = createInitialPlayerState();
        // 251 "Head to Sol" is offered at any Federation (govt 128) stellar.
        const fedPlanet = planets.find(planet => planet.government === 128
            && planet.inhabited !== false && !sameResourceId(planet.id, 'nova:128'))!;
        expect(fedPlanet).toBeDefined();

        const chain: Array<[string, string, MissionOfferLocation, string]> = [
            // [mission, offer stellar, offer location, completion stellar]
            ['nova:251', fedPlanet.id, MissionOfferLocation.MainSpaceport, 'nova:128'],
            ['nova:630', 'nova:128', MissionOfferLocation.Trading, 'nova:137'],
            ['nova:631', 'nova:137', MissionOfferLocation.Trading, 'nova:138'],
            ['nova:632', 'nova:138', MissionOfferLocation.Trading, 'nova:128'],
            ['nova:633', 'nova:128', MissionOfferLocation.Outfit, 'nova:191'],
        ];
        for (const [id, at, location, completeAt] of chain) {
            expect(offerable(state, at, location)).withContext(`${id} at ${at}`).toContain(id);
            accept(state, id, at);
            const notices = await runtime.processLanding(state, completeAt);
            expect(notices.map(notice => `${notice.missionId}:${notice.kind}`))
                .withContext(`${id} lands at ${completeAt}`)
                .toContain(`${id}:success`);
            expect(offerable(state, at, location)).withContext(`${id} done`).not.toContain(id);
        }
        expect(state.missionBits[9204]).toBe(true);
        expect(offerable(state, 'nova:191', MissionOfferLocation.Bar)).toContain('nova:754');
    });

    it('offers Rebel Food Drop 330 at Rebel I, its own ReturnStel', () => {
        if (skipWithoutRetailData()) return;
        const state = createInitialPlayerState();
        expect(offerable(state, 'nova:171', MissionOfferLocation.Bar)).not.toContain('nova:330');
        state.missionBits[124] = true;
        expect(offerable(state, 'nova:171', MissionOfferLocation.Bar)).toContain('nova:330');
    });

    it('offers Sigma Bulk Delivery 557 to a Leviathan but not a Shuttle', () => {
        if (skipWithoutRetailData()) return;
        expect(missions.get('nova:557')!.require).toEqual([0, 0x10]);
        const state = createInitialPlayerState();
        state.cargoCapacity = 1000;
        const earth = 'nova:128';
        expect(offerable(state, earth, MissionOfferLocation.MissionComputer,
            { contribute: [0, 0x1] })).not.toContain('nova:557');
        expect(offerable(state, earth, MissionOfferLocation.MissionComputer,
            { contribute: [0, 0x11] })).toContain('nova:557');
    });

    async function acceptAndStart(state: PlayerState, id: string, planetId: string) {
        const entry = accept(state, id, planetId);
        const galaxy = visibleGalaxy(systems, planets, state.missionBits);
        await startPendingNcbMissions(gameData, state, {
            initialPlanetId: planetId,
            planets: galaxy.planets,
            systems: galaxy.systems,
            governments,
            initialSystemId: state.currentSystem,
            currentSystemId: state.currentSystem,
            random: () => 0,
        });
        return entry;
    }

    async function walkStep(
        runtime: MissionRuntime,
        state: PlayerState,
        step: {
            id: string;
            offerAt: string;
            location: MissionOfferLocation;
            completeAt: string;
            travelAt?: string;
            shipGoals?: readonly MissionGoalEvent[];
            verifyPrematureBlocked?: boolean;
        },
    ) {
        expect(offerable(state, step.offerAt, step.location))
            .withContext(step.id + ' offered at ' + step.offerAt)
            .toContain(step.id);
        const entry = await acceptAndStart(state, step.id, step.offerAt);

        const resolvedTravel = step.travelAt
            ?? (entry.travelDestination
                && entry.travelDestination !== '*'
                && !sameResourceId(entry.travelDestination, step.completeAt)
                ? entry.travelDestination
                : undefined);

        if (step.verifyPrematureBlocked) {
            const premature = await runtime.processLanding(state, step.completeAt);
            expect(premature.map(n => n.missionId + ':' + n.kind))
                .withContext(step.id + ' must not complete before leg/goal')
                .not.toContain(step.id + ':success');
        }

        if (resolvedTravel) {
            const mid = await runtime.processLanding(state, resolvedTravel);
            expect(mid.map(n => n.missionId + ':' + n.kind))
                .withContext(step.id + ' travel leg at ' + resolvedTravel)
                .not.toContain(step.id + ':success');
            expect(entry.travelVisited)
                .withContext(step.id + ' travelVisited at ' + resolvedTravel)
                .toBe(true);
        }

        for (const event of step.shipGoals ?? []) {
            await runtime.recordShipGoal(
                state,
                entry.missionUuid ?? entry.missionId,
                event,
            );
        }

        const notices = await runtime.processLanding(state, step.completeAt);
        expect(notices.map(n => n.missionId + ':' + n.kind))
            .withContext(step.id + ' completes at ' + step.completeAt)
            .toContain(step.id + ':success');
        expect(offerable(state, step.offerAt, step.location))
            .withContext(step.id + ' no longer offered after completion')
            .not.toContain(step.id);
    }

    it('walks the Federation opening chain 430 -> 431 -> 432 -> 433 -> 434', async () => {
        if (skipWithoutRetailData()) return;
        const runtime = new MissionRuntime(gameData);
        const state = createInitialPlayerState();
        state.missionBits[51] = true;
        state.cargoCapacity = 40;

        await walkStep(runtime, state, {
            id: 'nova:430',
            offerAt: 'nova:133',
            location: MissionOfferLocation.Outfit,
            travelAt: 'nova:128',
            completeAt: 'nova:133',
            verifyPrematureBlocked: true,
        });
        await walkStep(runtime, state, {
            id: 'nova:431',
            offerAt: 'nova:133',
            location: MissionOfferLocation.Outfit,
            travelAt: 'nova:128',
            completeAt: 'nova:136',
        });
        await walkStep(runtime, state, {
            id: 'nova:432',
            offerAt: 'nova:136',
            location: MissionOfferLocation.Outfit,
            travelAt: 'nova:128',
            completeAt: 'nova:150',
        });
        await walkStep(runtime, state, {
            id: 'nova:433',
            offerAt: 'nova:150',
            location: MissionOfferLocation.Outfit,
            travelAt: 'nova:128',
            completeAt: 'nova:133',
        });

        expect(state.missionBits[52]).toBe(true);
        expect(state.missionBits[53]).toBe(true);
        expect(state.missionBits[54]).toBe(true);
        expect(state.missionBits[55]).toBe(true);
        expect(state.holds.filter(c => c.isMissionCargo)).toEqual([]);
        expect(offerable(state, 'nova:128', MissionOfferLocation.Bar)).toContain('nova:434');
    });

    it('walks the Rebellion opening chain 330 -> 331 -> 333 -> 335', async () => {
        if (skipWithoutRetailData()) return;
        const runtime = new MissionRuntime(gameData);
        const state = createInitialPlayerState();
        state.missionBits[124] = true;
        state.cargoCapacity = 30;

        await walkStep(runtime, state, {
            id: 'nova:330',
            offerAt: 'nova:171',
            location: MissionOfferLocation.Bar,
            travelAt: 'nova:140',
            completeAt: 'nova:171',
            verifyPrematureBlocked: true,
        });
        expect(state.missionBits[126]).toBe(true);
        expect(state.missionBits[512]).toBe(true);
        expect(state.activeMissions.some(m => m.missionId === 'nova:819')).toBe(true);

        await walkStep(runtime, state, {
            id: 'nova:331',
            offerAt: 'nova:171',
            location: MissionOfferLocation.Bar,
            travelAt: 'nova:149',
            completeAt: 'nova:171',
        });
        expect(state.missionBits[127]).toBe(true);
        expect(state.missionBits[667]).toBe(true);

        await walkStep(runtime, state, {
            id: 'nova:333',
            offerAt: 'nova:171',
            location: MissionOfferLocation.Bar,
            completeAt: 'nova:171',
            verifyPrematureBlocked: true,
        });
        expect(state.missionBits[128]).toBe(true);
        expect(state.holds.filter(c => c.isMissionCargo)).toEqual([]);
        expect(offerable(state, 'nova:171', MissionOfferLocation.Bar)).toContain('nova:335');
    });

    it('walks the Vell-os opening chain 129 -> 130 -> 131 and enforces faction lockout', async () => {
        if (skipWithoutRetailData()) return;
        const runtime = new MissionRuntime(gameData);
        const state = createInitialPlayerState();
        state.missionBits[350] = true;
        state.cargoCapacity = 20;
        state.kills = 300;

        // Before committing to Vell-os, Pirate entry 693 is still available.
        expect(offerable(state, 'nova:157', MissionOfferLocation.Bar)).toContain('nova:693');

        await walkStep(runtime, state, {
            id: 'nova:129',
            offerAt: 'nova:128',
            location: MissionOfferLocation.MainSpaceport,
            travelAt: 'nova:408',
            completeAt: 'nova:128',
            verifyPrematureBlocked: true,
        });
        expect(state.missionBits[511]).toBe(true);
        expect(state.missionBits[351]).toBe(true);
        // Accepting Vell-os sets b511, locking out the Pirate entry mission.
        expect(offerable(state, 'nova:157', MissionOfferLocation.Bar)).not.toContain('nova:693');

        await walkStep(runtime, state, {
            id: 'nova:130',
            offerAt: 'nova:138',
            location: MissionOfferLocation.MainSpaceport,
            completeAt: 'nova:128',
        });
        expect(state.missionBits[352]).toBe(true);
        expect(state.missionBits[44]).toBe(true);
        expect(state.activeMissions.some(m => m.missionId === 'nova:818')).toBe(true);

        await walkStep(runtime, state, {
            id: 'nova:131',
            offerAt: 'nova:128',
            location: MissionOfferLocation.Bar,
            completeAt: 'nova:421',
        });
        expect(state.missionBits[353]).toBe(true);
        expect(state.activeMissions.some(m => m.missionId === 'nova:783')).toBe(true);
    });

    it('walks the Polaris opening chain 153 -> 717 -> 154 -> 155 -> 156 -> 157 with ship goals', async () => {
        if (skipWithoutRetailData()) return;
        const runtime = new MissionRuntime(gameData);
        const state = createInitialPlayerState();
        state.missionBits[277] = true;
        state.cargoCapacity = 20;
        state.kills = 1_000;

        await walkStep(runtime, state, {
            id: 'nova:153',
            offerAt: 'nova:217',
            location: MissionOfferLocation.Bar,
            completeAt: 'nova:137',
        });
        expect(state.missionBits[5757]).toBe(true);

        await walkStep(runtime, state, {
            id: 'nova:717',
            offerAt: 'nova:137',
            location: MissionOfferLocation.MainSpaceport,
            completeAt: 'nova:220',
        });
        expect(state.missionBits[278]).toBe(true);

        await walkStep(runtime, state, {
            id: 'nova:154',
            offerAt: 'nova:267',
            location: MissionOfferLocation.MainSpaceport,
            completeAt: 'nova:286',
        });
        // 154 uses R(b279 b316); verify one branch fired, then follow the b279 path.
        expect(Boolean(state.missionBits[279] || state.missionBits[316])).toBe(true);
        state.missionBits[279] = true;

        // 155 requires boarding 1 ship (shipGoal = 2).
        await walkStep(runtime, state, {
            id: 'nova:155',
            offerAt: 'nova:286',
            location: MissionOfferLocation.Bar,
            completeAt: 'nova:286',
            shipGoals: ['boarded'],
            verifyPrematureBlocked: true,
        });
        expect(state.missionBits[280]).toBe(true);

        // 156 requires observing 3 ships (shipGoal = 4).
        await walkStep(runtime, state, {
            id: 'nova:156',
            offerAt: 'nova:286',
            location: MissionOfferLocation.Bar,
            completeAt: 'nova:286',
            shipGoals: ['observed'],
            verifyPrematureBlocked: true,
        });
        expect(state.missionBits[281]).toBe(true);
        expect(state.activeMissions.some(m => m.missionId === 'nova:837')).toBe(true);

        state.missionBits[5759] = true;
        expect(offerable(state, 'nova:286', MissionOfferLocation.Bar)).toContain('nova:157');
    });

    it('walks the Auroran opening chain 660 -> 661 -> 664 -> 665 with rating gates and combat goals', async () => {
        if (skipWithoutRetailData()) return;
        const runtime = new MissionRuntime(gameData);
        const state = createInitialPlayerState();
        state.missionBits[207] = true;
        state.cargoCapacity = 20;
        state.kills = 0;

        expect(offerable(state, 'nova:360', MissionOfferLocation.Bar)).not.toContain('nova:660');
        state.kills = 150;

        await walkStep(runtime, state, {
            id: 'nova:660',
            offerAt: 'nova:360',
            location: MissionOfferLocation.Bar,
            travelAt: 'nova:177',
            completeAt: 'nova:360',
            verifyPrematureBlocked: true,
        });
        expect(state.missionBits[208]).toBe(true);
        expect(state.missionBits[6723]).toBeFalsy();

        await walkStep(runtime, state, {
            id: 'nova:661',
            offerAt: 'nova:360',
            location: MissionOfferLocation.Bar,
            travelAt: 'nova:138',
            completeAt: 'nova:360',
            verifyPrematureBlocked: true,
        });
        expect(state.missionBits[212]).toBe(true);

        expect(offerable(state, 'nova:360', MissionOfferLocation.Bar)).not.toContain('nova:664');
        state.kills = 500;
        await walkStep(runtime, state, {
            id: 'nova:664',
            offerAt: 'nova:360',
            location: MissionOfferLocation.Bar,
            completeAt: 'nova:360',
            shipGoals: ['boarded'],
            verifyPrematureBlocked: true,
        });
        expect(state.missionBits[213]).toBe(true);

        expect(offerable(state, 'nova:360', MissionOfferLocation.Bar)).not.toContain('nova:665');
        state.kills = 700;
        await walkStep(runtime, state, {
            id: 'nova:665',
            offerAt: 'nova:360',
            location: MissionOfferLocation.Bar,
            completeAt: 'nova:360',
            shipGoals: ['destroyed', 'destroyed', 'destroyed'],
            verifyPrematureBlocked: true,
        });
        expect(state.missionBits[214]).toBe(true);
        expect(state.activeMissions.some(m => m.missionId === 'nova:792')).toBe(false);
    });

    it('walks the Pirate opening chain 693 -> 694 -> 695 -> 696 -> 697 -> 698 from a fresh pilot', async () => {
        if (skipWithoutRetailData()) return;
        const runtime = new MissionRuntime(gameData);
        const state = createInitialPlayerState();
        state.cargoCapacity = 25;
        state.kills = 0;

        expect(offerable(state, 'nova:157', MissionOfferLocation.Bar)).not.toContain('nova:693');
        state.kills = 300;

        await walkStep(runtime, state, {
            id: 'nova:693',
            offerAt: 'nova:157',
            location: MissionOfferLocation.Bar,
            travelAt: 'nova:128',
            completeAt: 'nova:157',
            verifyPrematureBlocked: true,
        });
        expect(state.missionBits[511]).toBe(true);
        expect(state.missionBits[600]).toBe(true);

        await walkStep(runtime, state, {
            id: 'nova:694',
            offerAt: 'nova:157',
            location: MissionOfferLocation.Bar,
            completeAt: 'nova:211',
        });
        expect(state.missionBits[601]).toBe(true);

        await walkStep(runtime, state, {
            id: 'nova:695',
            offerAt: 'nova:157',
            location: MissionOfferLocation.Bar,
            travelAt: 'nova:136',
            completeAt: 'nova:157',
        });
        expect(state.missionBits[602]).toBe(true);

        await walkStep(runtime, state, {
            id: 'nova:696',
            offerAt: 'nova:157',
            location: MissionOfferLocation.Bar,
            completeAt: 'nova:215',
        });
        expect(state.missionBits[603]).toBe(true);

        await walkStep(runtime, state, {
            id: 'nova:697',
            offerAt: 'nova:157',
            location: MissionOfferLocation.Bar,
            completeAt: 'nova:421',
        });
        expect(state.missionBits[604]).toBe(true);
        expect(state.activeMissions.some(m => m.missionId === 'nova:783')).toBe(true);

        await walkStep(runtime, state, {
            id: 'nova:698',
            offerAt: 'nova:171',
            location: MissionOfferLocation.Bar,
            travelAt: 'nova:140',
            completeAt: 'nova:171',
        });
        expect(state.missionBits[650]).toBe(true);
        expect(state.holds.filter(c => c.isMissionCargo)).toEqual([]);
    });

    it('survives a mid-storyline save/reload checkpoint with active legs, cargo, and ship-goal progress', async () => {
        if (skipWithoutRetailData()) return;
        const runtime = new MissionRuntime(gameData);
        const state = createInitialPlayerState();
        state.missionBits[124] = true;
        state.missionBits[213] = true;
        state.kills = 700;
        state.cargoCapacity = 40;
        state.credits = 50_000;

        // 1. Accept Rebel 330 (10t cargo, travelStel 140 -> returnStel 171) and finish leg 1.
        expect(offerable(state, 'nova:171', MissionOfferLocation.Bar)).toContain('nova:330');
        const rebelEntry = await acceptAndStart(state, 'nova:330', 'nova:171');
        await runtime.processLanding(state, 'nova:140');
        expect(rebelEntry.travelVisited).toBe(true);

        // 2. Accept Auroran 665 (destroy 3 ships) and record 2 of 3 kills before saving.
        expect(offerable(state, 'nova:360', MissionOfferLocation.Bar)).toContain('nova:665');
        const auroranEntry = await acceptAndStart(state, 'nova:665', 'nova:360');
        await runtime.recordShipGoal(state, auroranEntry.missionUuid!, 'destroyed');
        await runtime.recordShipGoal(state, auroranEntry.missionUuid!, 'destroyed');
        expect(auroranEntry.shipGoalProgress?.destroyed).toBe(2);
        expect(auroranEntry.shipGoalProgress?.completed).toBe(false);

        // 3. Round-trip through canonical persistence JSON + makePlayerData projection.
        const persistedJson = JSON.parse(JSON.stringify(toPersistentPlayerState(state)));
        const reloaded = makePlayerData('pilot-checkpoint', {
            state: persistedJson,
            savedAt: 1_700_000_000_000,
        });
        const restored = reloaded.playerState!;
        expect(restored).toBeDefined();
        expect(restored.missionBits[124]).toBe(true);
        expect(restored.missionBits[213]).toBe(true);
        expect(restored.missionBits[518]).toBe(true);
        expect(restored.kills).toBe(700);
        expect(restored.credits).toBe(state.credits);
        expect(restored.freeSpace).toBe(30);

        const restoredRebel = restored.activeMissions.find(m => m.missionId === 'nova:330')!;
        const restoredAuroran = restored.activeMissions.find(m => m.missionId === 'nova:665')!;
        expect(restoredRebel.travelVisited).toBe(true);
        expect(restoredAuroran.shipGoalProgress?.destroyed).toBe(2);
        expect(restoredAuroran.shipGoalProgress?.completed).toBe(false);

        // 4. Resume on restored state: 665 still needs its 3rd kill before landing completes it.
        const premature = await runtime.processLanding(restored, 'nova:360');
        expect(premature.map(n => n.missionId)).not.toContain('nova:665');

        await runtime.recordShipGoal(restored, restoredAuroran.missionUuid!, 'destroyed');
        const auroranDone = await runtime.processLanding(restored, 'nova:360');
        expect(auroranDone.map(n => n.missionId + ':' + n.kind)).toContain('nova:665:success');
        expect(restored.missionBits[214]).toBe(true);

        const rebelDone = await runtime.processLanding(restored, 'nova:171');
        expect(rebelDone.map(n => n.missionId + ':' + n.kind)).toContain('nova:330:success');
        expect(restored.missionBits[126]).toBe(true);
        expect(restored.holds.filter(c => c.isMissionCargo)).toEqual([]);
        expect(restored.freeSpace).toBe(40);
    });
});
