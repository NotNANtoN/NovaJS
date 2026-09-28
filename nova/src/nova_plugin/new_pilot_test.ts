import 'jasmine';

import { getDefaultCharData } from 'novadatainterface/CharData';
import { getDefaultGovtData } from 'novadatainterface/GovtData';
import { MissionOfferLocation } from 'novadatainterface/MissionData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { NovaDataType } from 'novadatainterface/NovaDataInterface';
import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { retailDataPath, skipWithoutRetailData } from '../../../test/retail_data';
import { getOfferableMissions } from './mission_availability';
import { charStartGameDate, createStartingPlayerState } from './new_pilot';
import { createInitialPlayerState, formatGameDate } from './player_state';

function fakeGameData() {
    const gameData = new MockGameData();
    gameData.data.Ship.map.set('nova:128', { ...getDefaultShipData(), id: 'nova:128', cargoCapacity: 10, fuelCapacity: 300 });
    gameData.data.Ship.map.set('nova:140', { ...getDefaultShipData(), id: 'nova:140', cargoCapacity: 25, fuelCapacity: 400 });
    gameData.data.System.map.set('nova:130', { ...getDefaultSystemData(), id: 'nova:130', planets: ['nova:128'] });
    gameData.data.System.map.set('nova:150', { ...getDefaultSystemData(), id: 'nova:150',
        planets: ['nova:200', 'nova:201', 'nova:202'] });
    gameData.data.System.map.set('nova:151', { ...getDefaultSystemData(), id: 'nova:151', planets: ['nova:203'] });
    gameData.data.Planet.map.set('nova:128', { ...getDefaultPlanetData(), id: 'nova:128' });
    gameData.data.Planet.map.set('nova:200', { ...getDefaultPlanetData(), id: 'nova:200', canLand: false });
    gameData.data.Planet.map.set('nova:201', { ...getDefaultPlanetData(), id: 'nova:201', inhabited: false });
    gameData.data.Planet.map.set('nova:202', { ...getDefaultPlanetData(), id: 'nova:202' });
    gameData.data.Planet.map.set('nova:203', { ...getDefaultPlanetData(), id: 'nova:203' });
    gameData.data.Govt.map.set('nova:128', { ...getDefaultGovtData(), id: 'nova:128', classes: [1], allies: [2], enemies: [3] });
    gameData.data.Govt.map.set('nova:129', { ...getDefaultGovtData(), id: 'nova:129', classes: [2] });
    gameData.data.Govt.map.set('nova:130', { ...getDefaultGovtData(), id: 'nova:130', classes: [3] });
    gameData.data.Govt.map.set('nova:131', { ...getDefaultGovtData(), id: 'nova:131', classes: [4] });
    return gameData;
}

describe('createStartingPlayerState', () => {
    it('falls back to the built-in pilot when there is no chär', async () => {
        const state = await createStartingPlayerState(fakeGameData());
        const initial = createInitialPlayerState();
        expect(state.credits).toBe(initial.credits);
        expect(state.shipId).toBe(initial.shipId);
        expect(state.currentSystem).toBe(initial.currentSystem);
    });

    it('builds a pilot from the default chär', async () => {
        const gameData = fakeGameData();
        gameData.data.Char.map.set('nova:128', { ...getDefaultCharData(), id: 'nova:128', flags: 0, cash: 1 });
        gameData.data.Char.map.set('nova:130', { ...getDefaultCharData(), id: 'nova:130', flags: 1, cash: 99 });
        gameData.data.Char.map.set('nova:129', {
            ...getDefaultCharData(), id: 'nova:129', flags: 1,
            cash: 25_000, shipType: 140, systems: [150, 151, -1, -1],
            governments: [128, -1, -1, -1], status: [10, 0, 0, 0], kills: 3,
            startDay: 20, startMonth: 10, startYear: 1177, onStart: 'b12 !b13',
        });
        const logs: string[] = [];
        const state = await createStartingPlayerState(gameData, () => 0.1, { logger: m => logs.push(m) });
        expect(logs).toEqual([]);
        expect(state.credits).toBe(25_000);
        expect(state.shipId).toBe('nova:140');
        expect(state.cargoCapacity).toBe(25);
        expect(state.fuel).toBe(400);
        expect(state.currentSystem).toBe('nova:150');
        expect(state.lastLandedSystem).toBe('nova:150');
        // Skips the unlandable and the uninhabited stellar.
        expect(state.lastLandedPlanet).toBe('nova:202');
        expect(state.legalRecords).toEqual({ 'nova:128': 10, 'nova:129': 10, 'nova:130': -10 });
        expect(state.kills).toBe(3);
        expect(state.gameDate).toBe(2);
        expect(formatGameDate(state.gameDate)).toBe('20 October 1177 NC');
        expect(state.missionBits[12]).toBeTrue();
        expect(state.missionBits[13]).toBeFalse();

        const other = await createStartingPlayerState(gameData, () => 0.99);
        expect(other.currentSystem).toBe('nova:151');
        expect(other.lastLandedPlanet).toBe('nova:203');
    });

    it('uses system 128 when every starting system is -1 and keeps day 0 before the epoch', async () => {
        const gameData = fakeGameData();
        gameData.data.System.map.set('nova:128', { ...getDefaultSystemData(), id: 'nova:128', planets: ['nova:203'] });
        gameData.data.Char.map.set('nova:128', { ...getDefaultCharData(), id: 'nova:128',
            systems: [-1, -1, -1, -1], startDay: 23, startMonth: 6, startYear: 1177 });
        const logs: string[] = [];
        const state = await createStartingPlayerState(gameData, () => 0, { logger: m => logs.push(m) });
        expect(state.currentSystem).toBe('nova:128');
        expect(state.lastLandedPlanet).toBe('nova:203');
        expect(state.gameDate).toBe(0);
        expect(logs.some(log => log.includes('precedes the engine epoch'))).toBeTrue();
    });

    it('measures chär dates from 18 Oct 1177', () => {
        expect(charStartGameDate({ startDay: 18, startMonth: 10, startYear: 1177 })).toBe(0);
        expect(charStartGameDate({ startDay: 1, startMonth: 1, startYear: 1178 })).toBe(75);
        expect(charStartGameDate({ startDay: 23, startMonth: 6, startYear: 1177 })).toBeLessThan(0);
        expect(charStartGameDate({ startDay: 0, startMonth: 13, startYear: 1177 })).toBeUndefined();
    });
});

describe('retail new pilot', () => {
    it('starts from chär 128 with 25000 credits in a chär starting system', async () => {
        if (skipWithoutRetailData()) return;
        const { NovaParse } = await import('../../../novaparse/NovaParse');
        const parser = new NovaParse(retailDataPath(), false);
        const gameData = { data: parser.data, ids: parser.ids } as never;
        const starts = new Set<string>();
        for (const roll of [0, 0.3, 0.6, 0.99]) {
            const state = await createStartingPlayerState(gameData, () => roll, { logger: () => { } });
            expect(state.credits).toBe(25_000);
            expect(state.shipId).toBe('nova:128');
            expect(['nova:128', 'nova:136', 'nova:170', 'nova:184']).toContain(state.currentSystem);
            const planet = await parser.data[NovaDataType.Planet].get(state.lastLandedPlanet);
            expect(planet.canLand).withContext(planet.name).not.toBeFalse();
            starts.add(state.currentSystem);
        }
        expect(starts.size).toBe(4);
    }, 120_000);

    it('offers the tutorial (mïsn 251) on a new pilot\'s first landing at Kania', async () => {
        if (skipWithoutRetailData()) return;
        const { NovaParse } = await import('../../../novaparse/NovaParse');
        const parser = new NovaParse(retailDataPath(), false);
        const gameData = { data: parser.data, ids: parser.ids } as never;
        const state = await createStartingPlayerState(gameData, () => 0, { logger: () => { } });
        expect(state.currentSystem).toBe('nova:128');
        const system = await parser.data[NovaDataType.System].get(state.currentSystem);
        const planet = await parser.data[NovaDataType.Planet].get(state.lastLandedPlanet);
        const tutorial = await parser.data[NovaDataType.Mission].get('nova:251');
        expect(tutorial.availLoc).toBe(MissionOfferLocation.MainSpaceport);
        const offers = getOfferableMissions({
            missionIds: [tutorial.id], missions: new Map([[tutorial.id, tutorial]]),
            playerState: state, currentPlanet: planet, currentSystem: system,
            offerLocation: MissionOfferLocation.MainSpaceport, random: () => 0,
        });
        expect(offers.map(mission => mission.id)).withContext(`landed at ${planet.name}`)
            .toEqual(['nova:251']);
    }, 120_000);
});
