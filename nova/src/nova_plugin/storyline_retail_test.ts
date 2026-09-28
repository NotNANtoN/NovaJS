import 'jasmine';
import { NovaDataType } from 'novadatainterface/NovaDataInterface';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { MissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import { hasRetailData, retailDataPath, skipWithoutRetailData } from '../../../test/retail_data';
import { sameResourceId } from '../common/resource_id';
import { visibleGalaxy } from './system_variants';
import { getOfferableMissions, MissionAvailabilityInput } from './mission_availability';
import { acceptMission, MissionRuntime } from './mission_plugin';
import { createInitialPlayerState, PlayerState } from './player_state';
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
});
