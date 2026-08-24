import { MissionData, getDefaultMissionData } from 'novadatainterface/MissionData';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { MissionRuntime, acceptMission } from './mission_plugin';
import { createInitialPlayerState } from './player_state';

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
        expect(state.missionBits[11]).toBe(true);

        const notices = await new MissionRuntime(fakeGameData(mission))
            .processLanding(state, 'nova:131');
        expect(state.credits).toBe(10_250);
        expect(state.missionBits[12]).toBe(true);
        expect(state.activeMissions).toEqual([]);
        expect(notices[0].text).toBe(
            'Delivered 4 tons to Destination for 250 credits.',
        );
    });

    it('fails overdue missions and reports them on the next landing', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:201',
            returnStel: 131,
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
});
