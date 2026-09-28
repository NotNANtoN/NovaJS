import 'jasmine';
import { getDefaultPlanetData, PlanetData } from 'novadatainterface/PlanetData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { MissionRuntime } from './mission_plugin';
import { createInitialPlayerState, isStellarDestroyed } from './player_state';
import {
    dueRegenerations,
    isDestroyable,
    recordStellarDestroyed,
    recordStellarRegenerated,
    regenerationDate,
    startsDestroyed,
} from './stellar_destruction';

function planet(overrides: Partial<PlanetData> = {}): PlanetData {
    return {
        ...getDefaultPlanetData(),
        id: 'nova:200', name: 'Target', strength: 500, deadTime: 3,
        deadType: -1, onDestroy: 'b10', onRegen: 'b11 !b10', ...overrides,
    };
}

describe('stellar destruction bookkeeping', () => {
    it('knows which stellars are destroyable and start destroyed', () => {
        expect(isDestroyable({ strength: 1 })).toBeTrue();
        expect(isDestroyable({ strength: 0 })).toBeFalse();
        expect(isDestroyable({ strength: -1 })).toBeFalse();
        expect(isDestroyable(undefined)).toBeFalse();
        expect(startsDestroyed({ flags2: 0x0040 })).toBeTrue();
        expect(startsDestroyed({ flags2: 0x0001 })).toBeFalse();
    });

    it('computes regeneration dates from DeadTime', () => {
        expect(regenerationDate({ deadTime: 5 }, 10)).toBe(15);
        // DeadTime 0: "regenerates at the end of every day".
        expect(regenerationDate({ deadTime: 0 }, 10)).toBe(11);
        // -1: never regenerates on its own.
        expect(regenerationDate({ deadTime: -1 }, 10)).toBeUndefined();
        expect(regenerationDate({}, 10)).toBeUndefined();
    });

    it('records a destruction once, schedules regeneration and runs OnDestroy', () => {
        const state = createInitialPlayerState();
        state.gameDate = 40;
        expect(recordStellarDestroyed(state, planet())).toBeTrue();
        expect(isStellarDestroyed(state, 'nova:200')).toBeTrue();
        expect(state.stellarRegen).toEqual({ 'nova:200': 43 });
        expect(state.missionBits[10]).toBeTrue();
        state.missionBits[10] = false;
        // Already destroyed for this pilot: no second OnDestroy.
        expect(recordStellarDestroyed(state, planet())).toBeFalse();
        expect(state.missionBits[10]).toBeFalse();
    });

    it('does not schedule a stellar that never regenerates', () => {
        const state = createInitialPlayerState();
        state.stellarRegen = { 'nova:200': 99 };
        recordStellarDestroyed(state, planet({ deadTime: -1 }));
        expect(state.stellarRegen).toEqual({});
    });

    it('regenerates, clears the schedule and runs OnRegen', () => {
        const state = createInitialPlayerState();
        recordStellarDestroyed(state, planet());
        expect(recordStellarRegenerated(state, planet())).toBeTrue();
        expect(isStellarDestroyed(state, 'nova:200')).toBeFalse();
        expect(state.stellarRegen).toEqual({});
        expect(state.missionBits[11]).toBeTrue();
        expect(state.missionBits[10]).toBeFalse();
        expect(recordStellarRegenerated(state, planet())).toBeFalse();
    });

    it('lists only regenerations that are due', () => {
        expect(dueRegenerations({
            gameDate: 10,
            stellarRegen: { 'nova:1': 9, 'nova:2': 10, 'nova:3': 11 },
        })).toEqual(['nova:1', 'nova:2']);
        expect(dueRegenerations({ gameDate: 10 })).toEqual([]);
    });
});

describe('MissionRuntime.regenerateStellars', () => {
    it('regenerates due stellars for this pilot and runs OnRegen', async () => {
        const gameData = new MockGameData();
        gameData.data.Planet.map.set('nova:200', planet());
        gameData.data.Planet.map.set('nova:201', planet({ id: 'nova:201', onRegen: 'b12' }));
        const state = createInitialPlayerState();
        state.gameDate = 20;
        state.destroyedStellars = ['nova:200', 'nova:201'];
        state.stellarRegen = { 'nova:200': 20, 'nova:201': 21 };
        await new MissionRuntime(gameData).regenerateStellars(state);
        expect(state.destroyedStellars).toEqual(['nova:201']);
        expect(state.stellarRegen).toEqual({ 'nova:201': 21 });
        expect(state.missionBits[11]).toBeTrue();
        expect(state.missionBits[12]).toBeFalsy();
    });

    it('does nothing when nothing is due', async () => {
        const state = createInitialPlayerState();
        state.destroyedStellars = ['nova:200'];
        state.stellarRegen = { 'nova:200': 5 };
        state.gameDate = 4;
        await new MissionRuntime(new MockGameData()).regenerateStellars(state);
        expect(state.destroyedStellars).toEqual(['nova:200']);
    });
});
