import 'jasmine';
import {
    ControlsOverride, GameSettingsOverride, loadControlsOverride,
    loadGameSettings, loadPilotProfile, mergeControls, PrefsStorage,
    saveControlsOverride, saveGameSettings, savePilotProfile, clearPilotProfile,
    CONTROLS_OVERRIDE_KEY, PILOT_PROFILE_KEY, SETTINGS_OVERRIDE_KEY,
} from './client_prefs.js';

/** An in-memory PrefsStorage for testing without a browser. */
class MemoryStorage implements PrefsStorage {
    private map = new Map<string, string>();
    getItem(key: string) { return this.map.get(key) ?? null; }
    setItem(key: string, value: string) { this.map.set(key, value); }
    removeItem(key: string) { this.map.delete(key); }
    raw(key: string) { return this.map.get(key); }
}

describe('client_prefs', () => {
    describe('mergeControls', () => {
        it('overrides a single-key binding', () => {
            const base = { accelerate: 'ArrowUp', turnLeft: 'ArrowLeft' };
            const override: ControlsOverride = { accelerate: 'KeyW' };
            const merged = mergeControls(base, override);
            expect(merged['accelerate']).toBe('KeyW');
            expect(merged['turnLeft']).toBe('ArrowLeft');
        });

        it('replaces an array binding with the single override key', () => {
            const base = { fireSecondary: ['ControlLeft', 'ShiftLeft'] };
            const merged = mergeControls(base,
                { fireSecondary: 'KeyQ' } as ControlsOverride);
            expect(merged['fireSecondary']).toBe('KeyQ');
        });

        it('leaves untouched actions at their served default', () => {
            const base = { accelerate: 'ArrowUp', land: 'KeyL' };
            const merged = mergeControls(base, {});
            expect(merged).toEqual(base);
        });

        it('does not mutate the base object', () => {
            const base = { accelerate: 'ArrowUp' };
            mergeControls(base, { accelerate: 'KeyW' } as ControlsOverride);
            expect(base['accelerate']).toBe('ArrowUp');
        });

        it('treats an empty override value as explicitly unbound', () => {
            // '' is written when the player moves an action's key onto
            // another action; the served default must NOT come back, or
            // the displaced action would keep firing on the stolen key.
            const base = { accelerate: 'ArrowUp' };
            const merged = mergeControls(base,
                { accelerate: '' } as ControlsOverride);
            expect(merged['accelerate']).toEqual([]);
        });
    });

    describe('control override persistence', () => {
        it('round-trips through storage', () => {
            const store = new MemoryStorage();
            saveControlsOverride({ accelerate: 'KeyW', land: 'KeyP' }, store);
            expect(loadControlsOverride(store))
                .toEqual({ accelerate: 'KeyW', land: 'KeyP' });
            expect(store.raw(CONTROLS_OVERRIDE_KEY)).toBeDefined();
        });

        it('returns an empty object when nothing is stored', () => {
            expect(loadControlsOverride(new MemoryStorage())).toEqual({});
        });

        it('tolerates corrupt stored JSON', () => {
            const store = new MemoryStorage();
            store.setItem(CONTROLS_OVERRIDE_KEY, '{not json');
            expect(loadControlsOverride(store)).toEqual({});
        });
    });

    describe('game settings persistence', () => {
        it('round-trips through storage', () => {
            const store = new MemoryStorage();
            const settings: GameSettingsOverride = {
                shipAnimations: false, soundVolume: 'quiet',
            };
            saveGameSettings(settings, store);
            expect(loadGameSettings(store)).toEqual(settings);
            expect(store.raw(SETTINGS_OVERRIDE_KEY)).toBeDefined();
        });

        it('returns an empty object when nothing is stored', () => {
            expect(loadGameSettings(new MemoryStorage())).toEqual({});
        });
    });

    describe('pilot profile persistence', () => {
        it('round-trips and clears', () => {
            const store = new MemoryStorage();
            savePilotProfile({
                name: 'Ada Vega', nickname: 'Comet', gender: 'female',
                strict: true, shipNumber: 244,
            }, store);
            expect(loadPilotProfile(store)?.name).toBe('Ada Vega');
            expect(store.raw(PILOT_PROFILE_KEY)).toBeDefined();
            clearPilotProfile(store);
            expect(loadPilotProfile(store)).toBeUndefined();
        });

        it('returns undefined when no profile exists', () => {
            expect(loadPilotProfile(new MemoryStorage())).toBeUndefined();
        });
    });
});
