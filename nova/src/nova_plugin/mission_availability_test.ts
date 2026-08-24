import { getDefaultMissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import {
    getOfferableMissions,
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
});
