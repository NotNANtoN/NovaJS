import {
    MissionData,
    MissionOfferLocation,
    getDefaultMissionData,
} from 'novadatainterface/MissionData';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import {
    MissionRuntime,
    abortMission,
    acceptMission,
} from './mission_plugin';
import {
    createInitialPlayerState,
    getFreeSpace,
} from './player_state';
import { getOfferableMissions } from './mission_availability';

function fakeGameData(mission: MissionData): GameDataInterface {
    return {
        data: {
            Mission: { get: async () => mission },
            Planet: {
                get: async (id: string) => ({
                    id,
                    name: id === 'nova:131' ? 'Destination' : 'Origin',
                }),
            },
        },
        ids: Promise.resolve({} as never),
    } as unknown as GameDataInterface;
}

describe('mission runtime', () => {
    it('accepts a cargo mission and completes it on landing', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:200',
            returnStel: 131,
            travelStel: 131,
            cargoType: 2,
            cargoQty: 4,
            onAccept: 'b11',
            onSuccess: 'b12',
            payVal: 250,
            compText: 'Delivered <CQ> tons to <DST> for <PAY> credits.',
        };
        const state = createInitialPlayerState();
        const accepted = acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });

        expect(accepted?.destination).toBe('nova:131');
        expect(accepted?.cargo?.quantity).toBe(4);
        expect(getFreeSpace(state)).toBe(6);
        expect(state.missionBits[11]).toBe(true);

        const notices = await new MissionRuntime(fakeGameData(mission))
            .processLanding(state, 'nova:131');
        expect(state.credits).toBe(10_250);
        expect(state.missionBits[12]).toBe(true);
        expect(state.activeMissions).toEqual([]);
        expect(getFreeSpace(state)).toBe(10);
        expect(notices[0].text).toBe(
            'Delivered 4 tons to Destination for 250 credits.',
        );
    });

    it('fails overdue missions and reports them on the next landing', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:201',
            returnStel: 131,
            cargoType: 0,
            cargoQty: 2,
            timeLimit: 1,
            onFailure: 'b13',
            failText: 'Contract failed at <DST>.',
        };
        const state = createInitialPlayerState();
        acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });
        state.gameDate = 2;

        const notices = await new MissionRuntime(fakeGameData(mission))
            .processLanding(state, 'nova:130');
        expect(state.missionBits[13]).toBe(true);
        expect(state.activeMissions).toEqual([]);
        expect(getFreeSpace(state)).toBe(10);
        expect(notices[0].kind).toBe('failure');
        expect(notices[0].text).toBe('Contract failed at Destination.');
    });

    it('resolves random and government selectors once into active state', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:202',
            travelStel: -2,
            returnStel: 15000,
            shipCount: 0,
            shipSyst: -2,
        };
        const state = createInitialPlayerState();
        const accepted = acceptMission(state, mission, {
            initialPlanetId: 'nova:128',
            initialSystemId: 'nova:128',
            planets: [
                { id: 'nova:128', inhabited: true, government: 128, systemId: 'nova:128' },
                { id: 'nova:129', inhabited: true, government: 129, systemId: 'nova:129' },
                { id: 'nova:130', inhabited: false, government: 130, systemId: 'nova:130' },
            ],
            systems: [
                { id: 'nova:128', government: 128, planets: ['nova:128'] },
                { id: 'nova:129', government: 129, planets: ['nova:129'] },
            ],
            governments: [
                { index: 0, allies: [8], classes: [], enemies: [] },
                { index: 1, allies: [], classes: [8], enemies: [] },
            ],
            random: () => 0.99,
        });

        expect(accepted?.travelDestination).toBe('nova:129');
        expect(accepted?.returnDestination).toBe('nova:129');
        expect(accepted?.destination).toBe('nova:129');
        expect(accepted?.shipSystem).toBe('nova:129');
    });

    it('keeps ShipSyst -6 dynamic and fails an escort when it dies', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:132',
            returnStel: 131,
            shipCount: 1,
            shipSyst: -6,
            shipGoal: 3,
            shipBehav: 1,
            onFailure: 'b91',
            failText: 'The merchant was destroyed.',
        };
        const state = createInitialPlayerState();
        const accepted = acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });

        // Bible ShipSyst -6 is the player's current system, not the system
        // where the mission happened to be accepted.
        expect(accepted?.shipSystem).toBe('*');
        expect(await new MissionRuntime(fakeGameData(mission)).recordShipGoal(
            state, accepted!.missionUuid!, 'destroyed')).toBe(false);
        expect(accepted?.state).toBe('failed');
        expect(state.missionBits[91]).toBe(true);

        const notices = await new MissionRuntime(fakeGameData(mission))
            .processLanding(state, 'nova:130');
        expect(notices).toEqual([{
            missionId: 'nova:132',
            kind: 'failure',
            text: 'The merchant was destroyed.',
        }]);
        expect(state.activeMissions).toEqual([]);
    });

    it('completes a defend mission when attackers die or jump out', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:173',
            returnStel: 131,
            shipCount: 2,
            shipSyst: 131,
            shipGoal: 6,
            shipBehav: 0,
            onShipDone: 'b92',
            onSuccess: 'b93',
        };
        const state = createInitialPlayerState();
        const accepted = acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });
        const runtime = new MissionRuntime(fakeGameData(mission));

        expect(await runtime.recordShipGoal(
            state, accepted!.missionUuid!, 'destroyed')).toBe(false);
        expect(await runtime.recordShipGoal(
            state, accepted!.missionUuid!, 'chasedOff')).toBe(true);
        expect(state.missionBits[92]).toBe(true);

        await runtime.processLanding(state, 'nova:131');
        expect(state.missionBits[93]).toBe(true);
        expect(state.activeMissions).toEqual([]);
    });

    it('unlocks the retail Vellos2 to Vellos3 control-bit chain', async () => {
        const vellos2 = {
            ...getDefaultMissionData(),
            id: 'nova:129',
            name: 'Visit Vell-os Homeworld; Vellos2',
            availStel: 128,
            availLoc: MissionOfferLocation.MainSpaceport,
            travelStel: 408,
            returnStel: 128,
            onAccept: 'b511',
            onSuccess: 'b351 S797 b512 b515 b518',
        };
        const vellos3 = {
            ...getDefaultMissionData(),
            id: 'nova:130',
            name: 'Return to Earth for Training; Vellos3',
            availStel: 128,
            availLoc: MissionOfferLocation.MainSpaceport,
            availBits: 'b351 & !(b352 | b4444)',
        };
        const state = createInitialPlayerState();
        const offers = () => getOfferableMissions({
            missionIds: [vellos3.id],
            missions: new Map([[vellos3.id, vellos3]]),
            playerState: state,
            currentPlanet: { id: 'nova:128', inhabited: true },
            currentSystem: { id: 'nova:130', links: [] },
            offerLocation: MissionOfferLocation.MainSpaceport,
            random: () => 0,
        });

        expect(offers()).toEqual([]);
        acceptMission(state, vellos2, {
            initialPlanetId: 'nova:128',
            planets: [{ id: 'nova:128' }, { id: 'nova:408' }],
        });
        await new MissionRuntime(fakeGameData(vellos2)).processLanding(
            state, 'nova:128', { onStartMission: () => undefined });

        expect(state.missionBits[351]).toBe(true);
        expect(offers()).toEqual([vellos3]);
    });

    it('releases mission cargo when a mission is aborted', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:203',
            returnStel: 131,
            cargoType: 0,
            cargoQty: 3,
        };
        const state = createInitialPlayerState();
        const accepted = acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });
        expect(accepted).toBeDefined();
        expect(getFreeSpace(state)).toBe(7);
        expect(abortMission(state, accepted!, mission)).toBe(true);
        expect(state.activeMissions).toEqual([]);
        expect(getFreeSpace(state)).toBe(10);
    });

    it('runs and completes a persisted procedural mission record', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'proc:abc:0',
            name: 'Generated delivery',
            returnStel: -1,
            travelStel: -1,
            cargoType: 0,
            cargoQty: 2,
            dropOffMode: 0,
            payVal: 500,
            compText: 'Generated delivery complete.',
        };
        const state = createInitialPlayerState();
        const accepted = acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            resolved: {
                travelDestination: 'nova:131',
                returnDestination: 'nova:131',
            },
        });
        expect(accepted?.missionData).toEqual(mission);
        const notices = await new MissionRuntime(fakeGameData(
            getDefaultMissionData(),
        )).processLanding(state, 'nova:131');
        expect(notices[0]?.kind).toBe('success');
        expect(state.credits).toBe(10_500);
        expect(state.activeMissions).toEqual([]);
        expect(getFreeSpace(state)).toBe(10);
    });
});
