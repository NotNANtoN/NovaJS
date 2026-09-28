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
    applyMissionPay,
    startPendingNcbMissions,
} from './mission_plugin';
import { getDefaultCronData } from 'novadatainterface/CronData';
import {
    createInitialPlayerState,
    getFreeSpace,
} from './player_state';
import { getOfferableMissions } from './mission_availability';

function fakeGameData(...missions: MissionData[]): GameDataInterface {
    const byId = new Map<string, MissionData>();
    for (const mission of missions) {
        byId.set(mission.id, mission);
        byId.set(mission.id.replace(/^.*:/, ''), mission);
    }
    return {
        data: {
            Mission: {
                get: async (id: string) => {
                    const found = byId.get(id)
                        ?? byId.get(id.replace(/^.*:/, ''));
                    if (!found) {
                        throw new Error(`missing mission ${id}`);
                    }
                    return found;
                },
            },
            Planet: {
                get: async (id: string) => ({
                    id,
                    name: id === 'nova:131' ? 'Destination' : (id === 'nova:130' ? 'Origin' : id),
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

    it('accepts a zero-ton cargo mission without cargo allocation failure', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:251',
            returnStel: 131,
            travelStel: 131,
            cargoType: 0,
            cargoQty: 0,
            payVal: 500,
        };
        const state = createInitialPlayerState();
        const accepted = acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });

        expect(accepted).toBeDefined();
        expect(accepted?.destination).toBe('nova:131');
        expect(accepted?.cargo?.quantity).toBe(0);
        expect(state.activeMissions.length).toBe(1);
        expect(state.holds.length).toBe(0);
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
        const followUp = {
            ...getDefaultMissionData(),
            id: 'nova:797',
            name: 'Vellos follow-up',
            travelStel: 128,
            returnStel: 128,
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
        const runtime = new MissionRuntime(fakeGameData(vellos2, followUp));
        await runtime.processLanding(state, 'nova:408');
        expect(state.activeMissions.length).toBe(1);
        expect(state.missionBits[351]).toBe(false);

        await runtime.processLanding(state, 'nova:128');

        expect(state.missionBits[351]).toBe(true);
        expect(state.activeMissions.map(entry => entry.missionId))
            .toEqual(['nova:797']);
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

    it('completes a passenger ferry on landing at TravelStel', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'proc:ferry:0',
            name: 'Ferry 2 passengers to Destination',
            returnStel: 130,
            travelStel: 131,
            cargoType: 0,
            cargoQty: 2,
            cargo: 'passengers',
            dropOffMode: 0,
            payVal: 800,
            timeLimit: 3,
            compText: 'Passengers delivered.',
        };
        const state = createInitialPlayerState();
        const accepted = acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });
        expect(accepted?.destination).toBe('nova:131');
        expect(accepted?.travelDestination).toBe('nova:131');
        expect(accepted?.returnDestination).toBe('nova:130');

        const notices = await new MissionRuntime(fakeGameData(mission))
            .processLanding(state, 'nova:131');
        expect(notices[0]?.kind).toBe('success');
        expect(notices[0]?.text).toBe('Passengers delivered.');
        expect(state.credits).toBe(10_800);
        expect(state.activeMissions).toEqual([]);
        expect(getFreeSpace(state)).toBe(10);
    });

    it('still completes a drop-off whose stored destination is ReturnStel', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'proc:ferry:stale',
            name: 'Ferry 2 passengers to Destination',
            returnStel: 130,
            travelStel: 131,
            cargoType: 0,
            cargoQty: 2,
            cargo: 'passengers',
            dropOffMode: 0,
            payVal: 400,
        };
        const state = createInitialPlayerState();
        const accepted = acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });
        expect(accepted).toBeDefined();
        accepted!.destination = 'nova:130';
        accepted!.missionData = mission;

        const notices = await new MissionRuntime(fakeGameData(mission))
            .processLanding(state, 'nova:131');
        expect(notices[0]?.kind).toBe('success');
        expect(state.activeMissions).toEqual([]);
    });

    it('completes a mission targeting a planet when landing on a story clone with the same name', async () => {
        // Mission targets Earth (nova:128)
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:251',
            name: 'Head to Sol',
            travelStel: -1,
            returnStel: 128,
            dropOffMode: 1,
            onSuccess: 'b9200',
            compText: 'Welcome to Earth, captain.',
        };
        const state = createInitialPlayerState();
        acceptMission(state, mission, {
            initialPlanetId: 'nova:134', // New Babylon in Nesre Primus
            resolved: {
                travelDestination: '*',
                returnDestination: 'nova:128',
            },
        });
        expect(state.activeMissions.length).toBe(1);

        // Player lands on Earth clone in alternate Sol system (nova:426)
        const gameDataWithEarthClone = {
            data: {
                Mission: { get: async () => mission },
                Planet: {
                    get: async (id: string) => ({
                        id,
                        name: (id === 'nova:128' || id === 'nova:426') ? 'Earth' : id,
                    }),
                },
            },
            ids: Promise.resolve({} as never),
        } as unknown as GameDataInterface;

        const runtime = new MissionRuntime(gameDataWithEarthClone);
        const notices = await runtime.processLanding(state, 'nova:426');

        expect(notices[0]?.kind).toBe('success');
        expect(notices[0]?.text).toContain('Welcome to Earth');
        expect(state.missionBits[9200]).toBeTrue();
        expect(state.activeMissions).toEqual([]);
    });

    it('completes a landing even if expiration is already loading the mission', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:204',
            travelStel: 131,
            returnStel: 131,
            dropOffMode: 0,
            payVal: 100,
        };
        let releaseLoad: () => void = () => undefined;
        const pending = new Promise<void>(resolve => {
            releaseLoad = resolve;
        });
        const runtime = new MissionRuntime({
            data: {
                Mission: {
                    get: async () => {
                        await pending;
                        return mission;
                    },
                },
                Planet: {
                    get: async (id: string) => ({ id, name: 'Destination' }),
                },
            },
            ids: Promise.resolve({} as never),
        } as unknown as GameDataInterface);
        const state = createInitialPlayerState();
        acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });
        const expiration = runtime.checkDate(state);
        expect(expiration).toBeDefined();
        const landing = runtime.processLanding(state, 'nova:131');
        releaseLoad();
        const notices = await landing;
        await expiration;
        expect(notices[0]?.kind).toBe('success');
        expect(state.activeMissions).toEqual([]);
    });

    it('picks up delayed cargo at TravelStel and pays out at ReturnStel', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:205',
            travelStel: 131,
            returnStel: 130,
            cargoType: 0,
            cargoQty: 3,
            pickupMode: 1,
            dropOffMode: 1,
            payVal: 200,
        };
        const state = createInitialPlayerState();
        const accepted = acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });
        expect(accepted?.cargo?.quantity).toBe(3);
        expect(getFreeSpace(state)).toBe(10);

        const runtime = new MissionRuntime(fakeGameData(mission));
        await runtime.processLanding(state, 'nova:131');
        expect(getFreeSpace(state)).toBe(7);
        expect(state.activeMissions.length).toBe(1);

        const notices = await runtime.processLanding(state, 'nova:130');
        expect(notices[0]?.kind).toBe('success');
        expect(state.credits).toBe(10_200);
        expect(state.activeMissions).toEqual([]);
        expect(getFreeSpace(state)).toBe(10);
    });

    it('advances the date and legal record when a mission pays out', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:206',
            travelStel: 131,
            returnStel: 131,
            dropOffMode: 0,
            payVal: 50,
            datePostInc: 4,
            compGovt: 128,
            compReward: 12,
        };
        const state = createInitialPlayerState();
        acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });
        const notices = await new MissionRuntime(fakeGameData(mission))
            .processLanding(state, 'nova:131');
        expect(notices[0]?.kind).toBe('success');
        expect(state.gameDate).toBe(4);
        expect(state.legalRecords?.['nova:128']).toBe(12);
        expect(state.credits).toBe(10_050);
    });

    it('starts a catalog mission queued by OnAbort', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:207',
            travelStel: -1,
            returnStel: -1,
            canAbort: true,
            onAbort: 'S208',
        };
        const followUp = {
            ...getDefaultMissionData(),
            id: 'nova:208',
            travelStel: -1,
            returnStel: -1,
        };
        const state = createInitialPlayerState();
        const accepted = acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
        });
        expect(abortMission(state, accepted!, mission)).toBe(true);
        await startPendingNcbMissions(
            fakeGameData(mission, followUp), state, {
                initialPlanetId: 'nova:130',
            });
        expect(state.activeMissions.map(entry => entry.missionId))
            .toEqual(['nova:208']);
    });
});

// Rebellion (141) allies classes 7 and 16; Federation (128) is class 7 and
// Auroran (129) class 16; Pirate (137) shares class 10 with the Rebellion.
const GOVERNMENTS = [
    { id: 'nova:141', classes: [10], allies: [7, 16], enemies: [] },
    { id: 'nova:128', classes: [7], allies: [], enemies: [] },
    { id: 'nova:129', classes: [16], allies: [], enemies: [] },
    { id: 'nova:137', classes: [10], allies: [], enemies: [] },
    { id: 'nova:150', classes: [3], allies: [], enemies: [] },
];

function dirtyRecords() {
    return {
        'nova:141': -50, 'nova:128': -20, 'nova:129': -5,
        'nova:137': -30, 'nova:150': -40,
    };
}

function payMission(payVal: number): MissionData {
    return {
        ...getDefaultMissionData(),
        id: 'nova:300',
        travelStel: 131,
        returnStel: 131,
        dropOffMode: 0,
        payVal,
    };
}

async function completeWith(mission: MissionData, setup?: (state: ReturnType<typeof createInitialPlayerState>) => void) {
    const state = createInitialPlayerState();
    setup?.(state);
    acceptMission(state, mission, {
        initialPlanetId: 'nova:130',
        planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        governments: GOVERNMENTS,
    });
    const notices = await new MissionRuntime(fakeGameData(mission))
        .processLanding(state, 'nova:131', {});
    return { state, notices };
}

describe('special PayVal', () => {
    it('cleans only the named government for -10128..-10383', () => {
        const state = createInitialPlayerState();
        state.legalRecords = { ...dirtyRecords(), 'nova:142': 15 };
        applyMissionPay(state, { payVal: -10141 }, GOVERNMENTS);
        expect(state.legalRecords).toEqual({
            ...dirtyRecords(), 'nova:141': 0, 'nova:142': 15,
        });
        // A positive record stays.
        applyMissionPay(state, { payVal: -10142 }, GOVERNMENTS);
        expect(state.legalRecords['nova:142']).toBe(15);
    });

    it('cleans the government and its allies for -20128..-20383', () => {
        const state = createInitialPlayerState();
        state.legalRecords = dirtyRecords();
        applyMissionPay(state, { payVal: -20141 }, GOVERNMENTS);
        expect(state.legalRecords).toEqual({
            ...dirtyRecords(), 'nova:141': 0, 'nova:128': 0, 'nova:129': 0,
        });
    });

    it('cleans the government and its classmates for -30128..-30383', () => {
        const state = createInitialPlayerState();
        state.legalRecords = dirtyRecords();
        applyMissionPay(state, { payVal: -30141 }, GOVERNMENTS);
        expect(state.legalRecords).toEqual({
            ...dirtyRecords(), 'nova:141': 0, 'nova:137': 0,
        });
    });

    it('cleans a record that only exists as a negative initial record', () => {
        const state = createInitialPlayerState();
        applyMissionPay(state, { payVal: -10150 }, [
            { id: 'nova:150', classes: [], initialRecord: -10 } as never,
        ]);
        expect(state.legalRecords?.['nova:150']).toBe(0);
    });

    it('takes a percentage of cash for -40001..-40099', async () => {
        const { state } = await completeWith(payMission(-40002));
        expect(state.credits).toBe(9_800);
    });

    it('charges -50000 and down when the mission starts', async () => {
        const mission = payMission(-50250);
        const state = createInitialPlayerState();
        acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });
        expect(state.credits).toBe(9_750);
        await new MissionRuntime(fakeGameData(mission)).processLanding(state, 'nova:131');
        expect(state.credits).toBe(9_750);
    });

    it('applies clean-record pay on completion using runtime governments', async () => {
        const mission = payMission(-20141);
        const data = fakeGameData(mission) as unknown as {
            data: Record<string, unknown>, ids: Promise<unknown>,
        };
        data.data.Govt = { get: async (id: string) => GOVERNMENTS.find(g => g.id === id) };
        data.ids = Promise.resolve({ Govt: GOVERNMENTS.map(g => g.id) });
        const state = createInitialPlayerState();
        state.legalRecords = dirtyRecords();
        acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });
        await new MissionRuntime(data as unknown as GameDataInterface)
            .processLanding(state, 'nova:131');
        expect(state.legalRecords['nova:128']).toBe(0);
        expect(state.legalRecords['nova:129']).toBe(0);
        expect(state.legalRecords['nova:150']).toBe(-40);
    });
});

describe('CompReward penalties', () => {
    it('halves CompReward against the record when a mission fails', async () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:301',
            returnStel: 131,
            timeLimit: 1,
            compGovt: 128,
            compReward: 10,
        };
        const state = createInitialPlayerState();
        state.legalRecords = { 'nova:128': 30 };
        acceptMission(state, mission, {
            initialPlanetId: 'nova:130',
            planets: [{ id: 'nova:130' }, { id: 'nova:131' }],
        });
        state.gameDate = 2;
        await new MissionRuntime(fakeGameData(mission)).failExpired(state);
        expect(state.legalRecords['nova:128']).toBe(25);
    });

    it('reverses -5x CompReward on abort with Flags 0x0040', () => {
        const mission = {
            ...getDefaultMissionData(),
            id: 'nova:302',
            travelStel: -1,
            returnStel: -1,
            compGovt: 128,
            compReward: 3,
            flags: 0x0040,
        };
        const state = createInitialPlayerState();
        const entry = acceptMission(state, mission, { initialPlanetId: 'nova:130' });
        expect(abortMission(state, entry!, mission)).toBe(true);
        expect(state.legalRecords?.['nova:128']).toBe(-15);

        const plain = createInitialPlayerState();
        const other = acceptMission(plain, { ...mission, flags: 0 }, { initialPlanetId: 'nova:130' });
        abortMission(plain, other!, { ...mission, flags: 0 });
        expect(plain.legalRecords?.['nova:128']).toBeUndefined();
    });
});

describe('auto-abort missions (Flags 0x0001)', () => {
    function silent(fields: Partial<MissionData>): MissionData {
        return {
            ...getDefaultMissionData(),
            id: 'nova:905',
            travelStel: -1,
            returnStel: -1,
            flags: 0x0001 | 0x0400,
            ...fields,
        };
    }

    it('pays and vanishes right after accept (retail 905)', () => {
        const state = createInitialPlayerState();
        const entry = acceptMission(state, silent({ flags2: 0x0002, payVal: 50000 }), {
            initialPlanetId: 'nova:130',
        });
        expect(entry?.state).toBe('aborted');
        expect(state.activeMissions).toEqual([]);
        expect(state.credits).toBe(60_000);
    });

    it('does not pay without Flags2 0x0002', () => {
        const state = createInitialPlayerState();
        acceptMission(state, silent({ payVal: 50000 }), { initialPlanetId: 'nova:130' });
        expect(state.credits).toBe(10_000);
    });

    it('runs OnAccept then OnAbort, advances the date and takes fuel', () => {
        // Retail 609 drop bear: OnAccept b45, OnAbort !b45, DatePostInc 14,
        // PayVal -40002 with Flags2 0x0002.
        const state = createInitialPlayerState();
        state.fuel = 300;
        const mission = silent({
            id: 'nova:609', onAccept: 'b45 b46', onAbort: '!b45',
            datePostInc: 14, flags2: 0x0002, payVal: -40002,
            flags: 0x0001 | 0x0008,
        });
        acceptMission(state, mission, { initialPlanetId: 'nova:130' });
        expect(state.missionBits[45]).toBe(false);
        expect(state.missionBits[46]).toBe(true);
        expect(state.gameDate).toBe(14);
        expect(state.credits).toBe(9_800);
        expect(state.fuel).toBe(200);
        expect(state.activeMissions).toEqual([]);
    });

    it('cleans a legal record on auto-abort (retail 896)', () => {
        const state = createInitialPlayerState();
        state.legalRecords = { 'nova:128': -100 };
        acceptMission(state, silent({ id: 'nova:896', flags2: 0x0002, payVal: -10128 }), {
            initialPlanetId: 'nova:130',
        });
        expect(state.legalRecords['nova:128']).toBe(0);
    });

    it('starts NCB missions queued by OnAccept/OnAbort afterwards', async () => {
        const follow = { ...getDefaultMissionData(), id: 'nova:748', travelStel: -1, returnStel: -1 };
        const mission = silent({ id: 'nova:747', onAccept: 'b166', onAbort: 'S748' });
        const state = createInitialPlayerState();
        acceptMission(state, mission, { initialPlanetId: 'nova:130' });
        await startPendingNcbMissions(fakeGameData(mission, follow), state, {
            initialPlanetId: 'nova:130',
        });
        expect(state.missionBits[166]).toBe(true);
        expect(state.activeMissions.map(entry => entry.missionId)).toEqual(['nova:748']);
    });

    it('keeps special-ship missions alive until the next landing', async () => {
        // Retail 614-629 "Avoid X": ShipCount 3-10, ShipGoal 0.
        const mission = silent({
            id: 'nova:614', shipCount: 4, shipGoal: 0, shipSyst: -6,
            onAccept: 'G348 !b6100', onAbort: 'b6100',
        });
        const state = createInitialPlayerState();
        acceptMission(state, mission, { initialPlanetId: 'nova:130' });
        expect(state.activeMissions.length).toBe(1);
        expect(state.missionBits[6100]).toBe(false);
        await new MissionRuntime(fakeGameData(mission)).processLanding(state, 'nova:131');
        expect(state.activeMissions).toEqual([]);
        expect(state.missionBits[6100]).toBe(true);
    });

    it('aborts a board/rescue mission once its goal completes (retail 141)', async () => {
        const mission = silent({
            id: 'nova:141', shipCount: 1, shipGoal: 5, shipSyst: -6,
            flags: 0x0001 | 0x0008 | 0x0400, flags2: 0x0002, payVal: 2000,
        });
        const state = createInitialPlayerState();
        state.fuel = 300;
        const entry = acceptMission(state, mission, { initialPlanetId: 'nova:130' });
        expect(state.activeMissions.length).toBe(1);
        const completed = await new MissionRuntime(fakeGameData(mission))
            .recordShipGoal(state, entry!.missionUuid!, 'boarded');
        expect(completed).toBe(true);
        expect(state.activeMissions).toEqual([]);
        expect(state.credits).toBe(12_000);
        expect(state.fuel).toBe(200);
    });

    it('drops an unfinished board/rescue auto-abort at landing without pay', async () => {
        const mission = silent({
            id: 'nova:650', shipCount: 1, shipGoal: 5, shipSyst: -6,
            flags2: 0x0002, payVal: 2000,
        });
        const state = createInitialPlayerState();
        acceptMission(state, mission, { initialPlanetId: 'nova:130' });
        await new MissionRuntime(fakeGameData(mission)).processLanding(state, 'nova:131');
        expect(state.activeMissions).toEqual([]);
        expect(state.credits).toBe(10_000);
    });
});

describe('MissionRuntime crön processing', () => {
    it('advances persistent cröns when the date changes and starts queued missions', async () => {
        const follow = { ...getDefaultMissionData(), id: 'nova:700', travelStel: -1, returnStel: -1 };
        const data = fakeGameData(follow) as unknown as {
            data: Record<string, unknown>, ids: Promise<unknown>,
        };
        const cron = {
            ...getDefaultCronData(), id: 'nova:500', duration: 2,
            enableOn: '!b600', onStart: 'b601', onEnd: 'b600 S700',
        };
        data.data.Cron = { get: async () => cron };
        data.data.Ship = { get: async () => ({ contribute: [0, 0] }) };
        data.ids = Promise.resolve({ Cron: ['nova:500'] });
        const runtime = new MissionRuntime(data as unknown as GameDataInterface);
        const state = createInitialPlayerState();
        await runtime.checkDate(state);
        expect(state.missionBits[601]).toBe(true);
        expect(runtime.activeCronIds(state)).toEqual(['nova:500']);
        state.gameDate = 2;
        await runtime.checkDate(state);
        expect(state.missionBits[600]).toBe(true);
        expect(state.activeMissions.map(entry => entry.missionId)).toEqual(['nova:700']);
    });
});
