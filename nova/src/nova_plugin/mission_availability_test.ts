import { getDefaultMissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import {
    getOfferableMissions,
    matchesRequiredOutfits,
    MissionAvailabilityInput,
} from './mission_availability';
import { createInitialPlayerState } from './player_state';

function makeInput(
    mission: ReturnType<typeof getDefaultMissionData>,
): MissionAvailabilityInput {
    return {
        missionIds: [mission.id],
        missions: new Map([[mission.id, mission]]),
        playerState: createInitialPlayerState(),
        currentPlanet: { id: 'nova:130', inhabited: true },
        currentSystem: { id: 'nova:130', links: [] },
        offerLocation: MissionOfferLocation.MissionComputer,
        random: () => 0,
    };
}

describe('mission availability', () => {
    it('enforces required installed outfits (mission.require)', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:205',
            require: [150, 0, 0, 0],
            destination: -1,
            travelStel: -1,
            returnDestination: -1,
            returnStel: -1,
        };
        const input = makeInput(mission);

        // Without outfit: rejected
        expect(getOfferableMissions(input)).toEqual([]);

        // With outfit: accepted
        input.outfits = new Map([['nova:150', { count: 1 }]]);
        expect(getOfferableMissions(input)).toEqual([mission]);
    });

    it('gates offers on AvailBits', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:200',
            availBits: 'b17',
            destination: -1,
            travelStel: -1,
            returnDestination: -1,
            returnStel: -1,
        };
        const input = makeInput(mission);

        expect(getOfferableMissions(input)).toEqual([]);
        input.playerState.missionBits[17] = true;
        expect(getOfferableMissions(input)).toEqual([mission]);
    });

    it('filters by AvailLoc', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:201',
            availLoc: MissionOfferLocation.Bar,
            destination: -1,
            travelStel: -1,
            returnDestination: -1,
            returnStel: -1,
        };
        const input = makeInput(mission);

        expect(getOfferableMissions(input)).toEqual([]);
        input.offerLocation = MissionOfferLocation.Bar;
        expect(getOfferableMissions(input)).toEqual([mission]);
    });

    it('excludes missions already active for the player', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:202',
            destination: -1,
            travelStel: -1,
            returnDestination: -1,
            returnStel: -1,
        };
        const input = makeInput(mission);

        expect(getOfferableMissions(input)).toEqual([mission]);
        input.playerState.activeMissions.push({
            missionId: mission.id,
            state: 'active',
            destination: '*',
            acceptedDate: 0,
        });
        expect(getOfferableMissions(input)).toEqual([]);
    });

    it('rejects ship-specific offers for a different ship', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:281',
            availShipType: 381,
            travelStel: -1,
            returnStel: -1,
        };
        const input = makeInput(mission);
        input.playerState.shipId = 'nova:128';
        expect(getOfferableMissions(input)).toEqual([]);
        input.playerState.shipId = 'nova:381';
        expect(getOfferableMissions(input)).toEqual([mission]);
    });

    it('only hides insufficient-cargo offers when flags2 requests it', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:211',
            cargoType: 0,
            cargoQty: 10,
            travelStel: -1,
            returnStel: -1,
        };
        const input = makeInput(mission);
        input.playerState.cargoCapacity = 5;
        input.playerState.holds = [];
        expect(getOfferableMissions(input)).toEqual([mission]);
        mission.flags2 = 0x0001;
        expect(getOfferableMissions(input)).toEqual([]);
    });

    it('evaluates government and adjacent-system AvailStel selectors', () => {
        const missions = [
            { value: 10000, id: 'nova:203' },
            { value: 15000, id: 'nova:204' },
            { value: 20000, id: 'nova:205' },
            { value: 25000, id: 'nova:206' },
            { value: 30000, id: 'nova:207' },
            { value: 31000, id: 'nova:208' },
            { value: 5129, id: 'nova:209' },
        ].map(({ value, id }) => ({
            ...getDefaultMissionData(),
            id,
            availStel: value,
            travelStel: -1,
            returnStel: -1,
        }));
        const input: MissionAvailabilityInput = {
            ...makeInput(missions[0]!),
            missionIds: missions.map(mission => mission.id),
            missions: new Map(missions.map(mission => [mission.id, mission])),
            currentPlanet: {
                id: 'nova:128',
                inhabited: true,
                government: 128,
                systemId: 'nova:128',
            },
            currentSystem: {
                id: 'nova:128',
                government: 128,
                links: ['nova:129'],
                planets: ['nova:128'],
            },
            destinationPlanets: [
                { id: 'nova:128', inhabited: true, government: 128, systemId: 'nova:128' },
                { id: 'nova:129', inhabited: true, government: 129, systemId: 'nova:129' },
                { id: 'nova:130', inhabited: true, government: 130, systemId: 'nova:130' },
            ],
            destinationSystems: [
                {
                    id: 'nova:128',
                    government: 128,
                    links: ['nova:129'],
                    planets: ['nova:128'],
                },
                {
                    id: 'nova:129',
                    government: 129,
                    links: ['nova:128'],
                    planets: ['nova:129'],
                },
                {
                    id: 'nova:130',
                    government: 130,
                    links: ['nova:129'],
                    planets: ['nova:130'],
                },
            ],
            governments: [
                { index: 0, classes: [7], allies: [8], enemies: [9] },
                { index: 1, classes: [7, 8], allies: [], enemies: [] },
                { index: 2, classes: [9], allies: [], enemies: [] },
            ],
        };
        expect(getOfferableMissions(input).map(mission => mission.id))
            .toEqual(['nova:203', 'nova:207', 'nova:209']);
    });

    it('gates offers on AvailRecord with the current stellar government', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:220',
            availRecord: 10,
            travelStel: -1,
            returnStel: -1,
        };
        const input = makeInput(mission);
        input.currentPlanet = {
            id: 'nova:128', inhabited: true, government: 128,
        };
        expect(getOfferableMissions(input)).toEqual([]);
        input.playerState.legalRecords = { 'nova:128': 10 };
        expect(getOfferableMissions(input)).toEqual([mission]);
        mission.availRecord = -20;
        expect(getOfferableMissions(input)).toEqual([]);
        input.playerState.legalRecords = { 'nova:128': -25 };
        expect(getOfferableMissions(input)).toEqual([mission]);
    });

    it('keeps domination AvailRecord missions closed', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:221',
            availRecord: -32000,
            travelStel: -1,
            returnStel: -1,
        };
        expect(getOfferableMissions(makeInput(mission))).toEqual([]);
        mission.availRecord = -32001;
        expect(getOfferableMissions(makeInput(mission))).toEqual([]);
    });

    it('gates offers on AvailRating ladder index and kill thresholds', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:222',
            availRating: 2,
            travelStel: -1,
            returnStel: -1,
        };
        const input = makeInput(mission);
        expect(getOfferableMissions(input)).toEqual([]);
        input.playerState.kills = 2;
        expect(getOfferableMissions(input)).toEqual([mission]);
        mission.availRating = 100;
        expect(getOfferableMissions(input)).toEqual([]);
        input.playerState.kills = 100;
        expect(getOfferableMissions(input)).toEqual([mission]);
    });

    it('gates inherent-government AvailShipType when the hull govt is known', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:223',
            availShipType: 2128,
            travelStel: -1,
            returnStel: -1,
        };
        const input = makeInput(mission);
        input.playerState.shipId = 'nova:128';
        expect(getOfferableMissions(input)).toEqual([mission]);
        input.playerShipGovt = 129;
        expect(getOfferableMissions(input)).toEqual([]);
        input.playerShipGovt = 128;
        expect(getOfferableMissions(input)).toEqual([mission]);
        mission.availShipType = 3128;
        expect(getOfferableMissions(input)).toEqual([]);
        input.playerShipGovt = 129;
        expect(getOfferableMissions(input)).toEqual([mission]);
    });
});
