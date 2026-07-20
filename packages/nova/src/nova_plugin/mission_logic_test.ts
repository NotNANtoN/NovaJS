import 'jasmine';
import { getDefaultGovtData, GovtData } from 'novadatainterface/govt_data';
import { getDefaultMissionData, MissionData } from 'novadatainterface/mission_data';
import {
    abortMission,
    acceptOffer,
    makeMissionOffer,
    matchesStellarRef,
    MissionContext,
    MissionMachineryContext,
    missionMatchesLocation,
    MissionWorkingState,
    LOCATION_BAR,
    LOCATION_MISSION_COMPUTER,
    processLanding,
    runMissionSetString,
    StellarInfo,
} from './mission_logic.js';
import { MAX_ACTIVE_MISSIONS, Missions } from './player_state_plugin.js';

function makeStellar(partial: Partial<StellarInfo> = {}): StellarInfo {
    return {
        id: 'nova:128',
        govt: null,
        uninhabited: false,
        canLand: true,
        ...partial,
    };
}

function makeMission(partial: Partial<MissionData> = {}): MissionData {
    return {
        ...getDefaultMissionData(),
        id: 'nova:200',
        name: 'Test Mission',
        ...partial,
    };
}

function makeGovt(id: string, partial: Partial<GovtData> = {}): GovtData {
    return { ...getDefaultGovtData(), id, ...partial };
}

function makeContext(partial: Partial<MissionContext> = {}): MissionContext {
    return {
        stellar: makeStellar(),
        stellarCandidates: [
            makeStellar(),
            makeStellar({ id: 'nova:129' }),
            makeStellar({ id: 'nova:130', uninhabited: true }),
        ],
        bits: new Set<number>(),
        shipId: 'nova:164',
        activeMissions: new Map(),
        freeCargoSpace: 20,
        random: () => 0.5,
        getGovt: () => undefined,
        currentDay: 1000,
        ...partial,
    };
}

function makeState(partial: Partial<MissionWorkingState> = {}): MissionWorkingState {
    return {
        missions: new Map() as Missions,
        cargo: new Map(),
        credits: { credits: 1000 },
        bits: new Set<number>(),
        cargoCapacity: 20,
        dateAdvance: 0,
        events: [],
        ...partial,
    };
}

function makeMachinery(state: MissionWorkingState,
    missionData: MissionData[],
    ctxPartial: Partial<MissionContext> = {}): MissionMachineryContext {
    const byId = new Map(missionData.map(m => [m.id, m]));
    return {
        state,
        getMission: id => byId.get(id),
        offerContext: () => makeContext({
            bits: state.bits,
            activeMissions: state.missions,
            freeCargoSpace: state.cargoCapacity,
            ...ctxPartial,
        }),
        random: () => 0.5,
    };
}

describe('matchesStellarRef', () => {
    const fed = makeGovt('nova:128', {
        classes: [1], allies: [2], enemies: [3],
    });
    const ally = makeGovt('nova:129', { classes: [2] });
    const enemy = makeGovt('nova:130', { classes: [3] });
    const govts = new Map([[fed.id, fed], [ally.id, ally], [enemy.id, enemy]]);
    const getGovt = (id: string) => govts.get(id);

    it('matches any inhabited stellar for -1', () => {
        expect(matchesStellarRef(-1, null, makeStellar(), 'nova', getGovt))
            .toBe(true);
        expect(matchesStellarRef(-1, null,
            makeStellar({ uninhabited: true }), 'nova', getGovt)).toBe(false);
    });

    it('matches a specific stellar by resolved id', () => {
        expect(matchesStellarRef(128, 'nova:128', makeStellar(), 'nova',
            getGovt)).toBe(true);
        expect(matchesStellarRef(128, 'nova:128',
            makeStellar({ id: 'nova:129' }), 'nova', getGovt)).toBe(false);
    });

    it('matches independent stellars for 9999', () => {
        expect(matchesStellarRef(9999, null, makeStellar({ govt: null }),
            'nova', getGovt)).toBe(true);
        expect(matchesStellarRef(9999, null,
            makeStellar({ govt: 'nova:128' }), 'nova', getGovt)).toBe(false);
    });

    it('matches govt stellars for the 10000 range', () => {
        const stellar = makeStellar({ govt: 'nova:128' });
        expect(matchesStellarRef(10000, null, stellar, 'nova', getGovt))
            .toBe(true);
        expect(matchesStellarRef(10001, null, stellar, 'nova', getGovt))
            .toBe(false);
    });

    it('matches allies for the 15000 range', () => {
        // govt 128's allies are class 2; nova:129 is class 2.
        expect(matchesStellarRef(15000, null,
            makeStellar({ govt: 'nova:129' }), 'nova', getGovt)).toBe(true);
        // The govt itself also matches.
        expect(matchesStellarRef(15000, null,
            makeStellar({ govt: 'nova:128' }), 'nova', getGovt)).toBe(true);
        expect(matchesStellarRef(15000, null,
            makeStellar({ govt: 'nova:130' }), 'nova', getGovt)).toBe(false);
    });

    it('matches non-govt stellars for the 20000 range', () => {
        expect(matchesStellarRef(20000, null,
            makeStellar({ govt: 'nova:128' }), 'nova', getGovt)).toBe(false);
        expect(matchesStellarRef(20000, null,
            makeStellar({ govt: 'nova:129' }), 'nova', getGovt)).toBe(true);
    });

    it('matches enemies for the 25000 range', () => {
        expect(matchesStellarRef(25000, null,
            makeStellar({ govt: 'nova:130' }), 'nova', getGovt)).toBe(true);
        expect(matchesStellarRef(25000, null,
            makeStellar({ govt: 'nova:129' }), 'nova', getGovt)).toBe(false);
    });

    it('matches classmates for the 30000/31000 ranges', () => {
        const classmate = makeGovt('nova:131', { classes: [1, 7] });
        const withClassmate = new Map(govts);
        withClassmate.set(classmate.id, classmate);
        const get = (id: string) => withClassmate.get(id);
        expect(matchesStellarRef(30000, null,
            makeStellar({ govt: 'nova:131' }), 'nova', get)).toBe(true);
        expect(matchesStellarRef(31000, null,
            makeStellar({ govt: 'nova:131' }), 'nova', get)).toBe(false);
        expect(matchesStellarRef(31000, null,
            makeStellar({ govt: 'nova:130' }), 'nova', get)).toBe(true);
    });

    describe('the AvailStel 5000-7047 adjacent-system range', () => {
        // System topology: nova:200 links to nova:201; nova:202 is
        // unconnected. Stellars: 300 in system 200, 301 in system 201,
        // 302 in system 202.
        const adjacency = {
            systemOfStellar: (id: string) => ({
                'nova:300': 'nova:200',
                'nova:301': 'nova:201',
                'nova:302': 'nova:202',
            } as Record<string, string | undefined>)[id],
            systemsAdjacentOrEqual: (a: string, b: string) => {
                if (a === b) return true;
                const links: Record<string, string[]> = {
                    'nova:200': ['nova:201'],
                    'nova:201': ['nova:200'],
                    'nova:202': [],
                };
                return links[a]?.includes(b) ?? false;
            },
        };
        // ref 5072 -> target system 128 + (5072 - 5000) = 200.
        const refFor200 = 5000 + (200 - 128);

        it('matches a stellar in the target system itself', () => {
            expect(matchesStellarRef(refFor200, null,
                makeStellar({ id: 'nova:300' }), 'nova', getGovt, adjacency))
                .toBe(true);
        });

        it('matches a stellar in an adjacent system', () => {
            expect(matchesStellarRef(refFor200, null,
                makeStellar({ id: 'nova:301' }), 'nova', getGovt, adjacency))
                .toBe(true);
        });

        it('rejects a stellar in a non-adjacent system', () => {
            expect(matchesStellarRef(refFor200, null,
                makeStellar({ id: 'nova:302' }), 'nova', getGovt, adjacency))
                .toBe(false);
        });

        it('never matches without an adjacency resolver (fail closed)', () => {
            expect(matchesStellarRef(refFor200, null,
                makeStellar({ id: 'nova:300' }), 'nova', getGovt))
                .toBe(false);
        });
    });
});

describe('missionMatchesLocation', () => {
    it('requires the location to match', () => {
        const mission = makeMission({ availLoc: LOCATION_BAR });
        const ctx = makeContext();
        expect(missionMatchesLocation(mission, LOCATION_BAR, ctx)).toBe(true);
        expect(missionMatchesLocation(mission, LOCATION_MISSION_COMPUTER, ctx))
            .toBe(false);
    });

    it('evaluates AvailBits against the real player bits', () => {
        const mission = makeMission({ availBits: 'b13 & !b14' });
        expect(missionMatchesLocation(mission, LOCATION_MISSION_COMPUTER,
            makeContext({ bits: new Set([13]) }))).toBe(true);
        expect(missionMatchesLocation(mission, LOCATION_MISSION_COMPUTER,
            makeContext({ bits: new Set([13, 14]) }))).toBe(false);
        expect(missionMatchesLocation(mission, LOCATION_MISSION_COMPUTER,
            makeContext())).toBe(false);
    });

    it('fails closed on malformed AvailBits', () => {
        const mission = makeMission({ availBits: 'b13 &&& !!!' });
        expect(missionMatchesLocation(mission, LOCATION_MISSION_COMPUTER,
            makeContext({ bits: new Set([13]) }))).toBe(false);
    });

    it('never offers a mission that is already active', () => {
        const mission = makeMission();
        const activeMissions: Missions = new Map([[mission.id, {
            id: mission.id, acceptedDay: 0, acceptedAt: 'nova:128',
            travelPlanet: null, returnPlanet: null, cargoType: -1,
            cargoQty: 0, cargoLoaded: false, travelDone: false,
            deadlineDay: null,
        }]]);
        expect(missionMatchesLocation(mission, LOCATION_MISSION_COMPUTER,
            makeContext({ activeMissions }))).toBe(false);
    });

    it('offers supported ship goals; suppresses board/rescue', () => {
        // Destroy goals are supported now (mission_ship_logic.ts).
        expect(missionMatchesLocation(makeMission({
            shipGoal: 0, shipCount: 3, shipDudeId: 'nova:240',
        }), LOCATION_MISSION_COMPUTER, makeContext())).toBe(true);
        // Board (2) and rescue (5) need boarding: still unofferable.
        expect(missionMatchesLocation(makeMission({
            shipGoal: 2, shipCount: 1, shipDudeId: 'nova:240',
        }), LOCATION_MISSION_COMPUTER, makeContext())).toBe(false);
        expect(missionMatchesLocation(makeMission({
            shipGoal: 5, shipCount: 1, shipDudeId: 'nova:240',
        }), LOCATION_MISSION_COMPUTER, makeContext())).toBe(false);
    });

    it('fails closed on nonzero Require masks', () => {
        const mission = makeMission({ require: '3' });
        expect(missionMatchesLocation(mission, LOCATION_MISSION_COMPUTER,
            makeContext())).toBe(false);
    });

    it('restricts by ship type', () => {
        const mustFly = makeMission({ availShipType: 164 });
        const mustNotFly = makeMission({ availShipType: 1164 });
        const ctx = makeContext({ shipId: 'nova:164' });
        expect(missionMatchesLocation(mustFly, LOCATION_MISSION_COMPUTER, ctx))
            .toBe(true);
        expect(missionMatchesLocation(mustNotFly, LOCATION_MISSION_COMPUTER,
            ctx)).toBe(false);
    });

    it('restricts by ship type across the full Bible range (128-895)', () => {
        // A high-id ship (>255) must still match a 128-895 restriction.
        const mustFly = makeMission({ availShipType: 500 });
        expect(missionMatchesLocation(mustFly, LOCATION_MISSION_COMPUTER,
            makeContext({ shipId: 'nova:500' }))).toBe(true);
        expect(missionMatchesLocation(mustFly, LOCATION_MISSION_COMPUTER,
            makeContext({ shipId: 'nova:164' }))).toBe(false);
    });

    it('restricts by the ship\'s inherent govt (2128+/3128+)', () => {
        // 2128 + (govt 130 - 128) = 2130: must fly a ship of govt 130.
        const mustBeGovt130 = makeMission({ availShipType: 2130 });
        const mustNotBeGovt130 = makeMission({ availShipType: 3130 });
        const govt130 = makeContext({ shipGovt: 'nova:130' });
        const govt129 = makeContext({ shipGovt: 'nova:129' });
        const noGovt = makeContext({ shipGovt: null });

        expect(missionMatchesLocation(mustBeGovt130,
            LOCATION_MISSION_COMPUTER, govt130)).toBe(true);
        expect(missionMatchesLocation(mustBeGovt130,
            LOCATION_MISSION_COMPUTER, govt129)).toBe(false);
        expect(missionMatchesLocation(mustBeGovt130,
            LOCATION_MISSION_COMPUTER, noGovt)).toBe(false);

        expect(missionMatchesLocation(mustNotBeGovt130,
            LOCATION_MISSION_COMPUTER, govt130)).toBe(false);
        expect(missionMatchesLocation(mustNotBeGovt130,
            LOCATION_MISSION_COMPUTER, govt129)).toBe(true);
        // A ship with no inherent govt is "not of govt 130".
        expect(missionMatchesLocation(mustNotBeGovt130,
            LOCATION_MISSION_COMPUTER, noGovt)).toBe(true);
    });
});

describe('makeMissionOffer', () => {
    it('resolves a random inhabited destination (-2)', () => {
        const mission = makeMission({ travelStel: -2 });
        const offer = makeMissionOffer(mission, makeContext());
        // The only inhabited candidate that isn't the current stellar.
        expect(offer?.travelPlanet).toBe('nova:129');
    });

    it('resolves the return stellar -4 to the offering stellar', () => {
        const mission = makeMission({ returnStel: -4 });
        const offer = makeMissionOffer(mission, makeContext());
        expect(offer?.returnPlanet).toBe('nova:128');
    });

    it('returns null when a destination cannot be resolved', () => {
        const mission = makeMission({ travelStel: -3 });
        const ctx = makeContext({
            stellarCandidates: [makeStellar()], // no uninhabited candidates
        });
        expect(makeMissionOffer(mission, ctx)).toBe(null);
    });

    it('resolves randomized cargo quantities (±50%)', () => {
        const mission = makeMission({ cargoType: 2, cargoQty: -10 });
        const low = makeMissionOffer(mission,
            makeContext({ random: () => 0 }));
        const high = makeMissionOffer(mission,
            makeContext({ random: () => 0.999 }));
        expect(low?.cargoQty).toBe(5);
        expect(high?.cargoQty).toBe(15);
    });

    it('resolves random cargo type (1000) to a standard type', () => {
        const mission = makeMission({ cargoType: 1000, cargoQty: 5 });
        const offer = makeMissionOffer(mission, makeContext());
        expect(offer?.cargoType).toBeGreaterThanOrEqual(0);
        expect(offer?.cargoType).toBeLessThanOrEqual(5);
    });

    it('marks the offer unacceptable when the cargo does not fit', () => {
        const mission = makeMission({ cargoType: 0, cargoQty: 50 });
        const offer = makeMissionOffer(mission,
            makeContext({ freeCargoSpace: 20 }));
        expect(offer?.acceptable).toBe(false);
        expect(offer?.reason).toContain('cargo space');
    });

    it('hides the offer entirely with the insufficient-space flag', () => {
        const mission = makeMission({ cargoType: 0, cargoQty: 50 });
        mission.flags = {
            ...mission.flags,
            notOfferedIfInsufficientCargoSpace: true,
        };
        expect(makeMissionOffer(mission, makeContext({ freeCargoSpace: 20 })))
            .toBe(null);
    });

    it('enforces the active mission cap', () => {
        const activeMissions: Missions = new Map();
        for (let i = 0; i < MAX_ACTIVE_MISSIONS; i++) {
            activeMissions.set(`nova:${300 + i}`, {
                id: `nova:${300 + i}`, acceptedDay: 0, acceptedAt: 'nova:128',
                travelPlanet: null, returnPlanet: null, cargoType: -1,
                cargoQty: 0, cargoLoaded: false, travelDone: false,
                deadlineDay: null,
            });
        }
        const offer = makeMissionOffer(makeMission(),
            makeContext({ activeMissions }));
        expect(offer?.acceptable).toBe(false);
        expect(offer?.reason).toContain('16');
    });
});

describe('accept / landing / completion flow', () => {
    it('runs a delivery mission end to end', () => {
        const mission = makeMission({
            id: 'nova:200',
            name: 'Delivery',
            travelStel: -1,
            returnStel: 129,
            returnStelId: 'nova:129',
            cargoType: 2,
            cargoQty: 10,
            pickupMode: 0,
            dropOffMode: 1,
            payVal: 15000,
            timeLimit: 30,
            onAccept: 'b100',
            onSuccess: 'b101 !b100',
            completionText: 'Thanks for the delivery.',
        });
        const state = makeState();
        const machinery = makeMachinery(state, [mission]);

        const offer = makeMissionOffer(mission, machinery.offerContext());
        expect(offer).not.toBe(null);
        expect(offer!.acceptable).toBe(true);

        acceptOffer(machinery, offer!);
        expect(state.missions.size).toBe(1);
        const active = state.missions.get('nova:200')!;
        expect(active.cargoLoaded).toBe(true);
        expect(state.cargo.get('mission:nova:200')).toBe(10);
        expect(state.bits.has(100)).toBe(true);
        expect(active.deadlineDay).toBe(1030);

        // Landing somewhere else does nothing.
        processLanding(machinery, 'nova:131', 1005);
        expect(state.missions.size).toBe(1);
        expect(state.events.filter(e => e.type === 'completed').length)
            .toBe(0);

        // Landing at the return stellar completes, pays, runs OnSuccess.
        processLanding(machinery, 'nova:129', 1010);
        expect(state.missions.size).toBe(0);
        expect(state.cargo.has('mission:nova:200')).toBe(false);
        expect(state.credits.credits).toBe(16000);
        expect(state.bits.has(101)).toBe(true);
        expect(state.bits.has(100)).toBe(false);
        const completed = state.events.find(e => e.type === 'completed')!;
        expect(completed.missionName).toBe('Delivery');
        expect(completed.payment).toBe(15000);
        expect(completed.text).toBe('Thanks for the delivery.');
    });

    it('handles a two-leg mission (travel then return)', () => {
        const mission = makeMission({
            id: 'nova:201',
            travelStel: 130,
            travelStelId: 'nova:130',
            returnStel: -4,
            cargoType: 1,
            cargoQty: 5,
            pickupMode: 1,   // pick up at travel stellar
            dropOffMode: 1,  // drop off at return
            payVal: 5000,
        });
        const state = makeState();
        const machinery = makeMachinery(state, [mission]);
        const offer = makeMissionOffer(mission, machinery.offerContext());
        acceptOffer(machinery, offer!);

        const active = state.missions.get('nova:201')!;
        expect(active.returnPlanet).toBe('nova:128');
        // Cargo is not loaded at accept (pickup at travel).
        expect(active.cargoLoaded).toBe(false);

        // Landing at the return stellar first does NOT complete.
        processLanding(machinery, 'nova:128', 1001);
        expect(state.missions.size).toBe(1);

        // Landing at the travel stellar picks up the cargo.
        processLanding(machinery, 'nova:130', 1002);
        expect(active.travelDone).toBe(true);
        expect(state.cargo.get('mission:nova:201')).toBe(5);

        // Now the return stellar completes.
        processLanding(machinery, 'nova:128', 1003);
        expect(state.missions.size).toBe(0);
        expect(state.credits.credits).toBe(6000);
    });

    it('fails a mission whose deadline passed, running OnFailure', () => {
        const mission = makeMission({
            id: 'nova:202',
            returnStel: 129,
            returnStelId: 'nova:129',
            timeLimit: 5,
            onFailure: 'b666',
            failText: 'You blew it.',
        });
        const state = makeState();
        const machinery = makeMachinery(state, [mission]);
        acceptOffer(machinery,
            makeMissionOffer(mission, machinery.offerContext())!);

        processLanding(machinery, 'nova:131', 1010); // day > 1005
        expect(state.missions.size).toBe(0);
        expect(state.bits.has(666)).toBe(true);
        const failed = state.events.find(e => e.type === 'failed')!;
        expect(failed.text).toBe('You blew it.');
    });

    it('aborts a mission, dropping its cargo and running OnAbort', () => {
        const mission = makeMission({
            id: 'nova:203',
            cargoType: 0,
            cargoQty: 8,
            pickupMode: 0,
            returnStel: 129,
            returnStelId: 'nova:129',
            onAbort: 'b55',
        });
        const state = makeState();
        const machinery = makeMachinery(state, [mission]);
        acceptOffer(machinery,
            makeMissionOffer(mission, machinery.offerContext())!);
        expect(state.cargo.get('mission:nova:203')).toBe(8);

        abortMission(machinery, 'nova:203');
        expect(state.missions.size).toBe(0);
        expect(state.cargo.has('mission:nova:203')).toBe(false);
        expect(state.bits.has(55)).toBe(true);
    });

    it('auto-abort missions run their effects and never stay', () => {
        const mission = makeMission({
            id: 'nova:204',
            payVal: 500,
            onAccept: 'b42',
            datePostInc: 2,
        });
        mission.flags = {
            ...mission.flags,
            autoAbort: true,
            applyPayOnAutoAbort: true,
        };
        const state = makeState();
        const machinery = makeMachinery(state, [mission]);
        acceptOffer(machinery,
            makeMissionOffer(mission, machinery.offerContext())!);
        expect(state.missions.size).toBe(0);
        expect(state.bits.has(42)).toBe(true);
        expect(state.credits.credits).toBe(1500);
        expect(state.dateAdvance).toBe(2);
    });
});

describe('mission set-string hooks (Sxxx/Axxx/Fxxx)', () => {
    it('Sxxx starts a mission by id through the real machinery', () => {
        const started = makeMission({
            id: 'nova:210',
            returnStel: 129,
            returnStelId: 'nova:129',
            onAccept: 'b77',
        });
        const state = makeState();
        const machinery = makeMachinery(state, [started]);
        runMissionSetString(machinery, 's210', 'nova');
        expect(state.missions.has('nova:210')).toBe(true);
        expect(state.bits.has(77)).toBe(true);
    });

    it('Axxx aborts and Fxxx fails active missions', () => {
        const a = makeMission({ id: 'nova:211', onAbort: 'b1' });
        const f = makeMission({ id: 'nova:212', onFailure: 'b2' });
        const state = makeState();
        const machinery = makeMachinery(state, [a, f]);
        acceptOffer(machinery,
            makeMissionOffer(a, machinery.offerContext())!);
        acceptOffer(machinery,
            makeMissionOffer(f, machinery.offerContext())!);
        expect(state.missions.size).toBe(2);

        runMissionSetString(machinery, 'a211 f212', 'nova');
        expect(state.missions.size).toBe(0);
        expect(state.bits.has(1)).toBe(true);
        expect(state.bits.has(2)).toBe(true);
    });

    it('guards against self-referential Sxxx recursion', () => {
        const loop = makeMission({
            id: 'nova:213',
            onAccept: 'a213 s213',
        });
        loop.flags = { ...loop.flags, autoAbort: true };
        const state = makeState();
        const machinery = makeMachinery(state, [loop]);
        // Must terminate.
        runMissionSetString(machinery, 's213', 'nova');
        expect(state.missions.size).toBe(0);
    });
});
