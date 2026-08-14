/**
 * Client-only preferences and pilot profile, persisted in localStorage.
 *
 * The server serves the base `settings.json` / `controls.json` read-only
 * (see setup_routes). A browser build can't write those back, so the
 * title screen's "Set Prefs" dialog persists the player's changes here
 * and the game start (browser.ts) layers them over the served defaults.
 *
 * This module never touches sim state: it is pure UI/config bookkeeping
 * kept beside the save (see save_game.ts).
 */

/** localStorage key: control-binding overrides (action -> event.code). */
export const CONTROLS_OVERRIDE_KEY = 'novajs:controls';
/** localStorage key: game-settings overrides (checkbox/volume state). */
export const SETTINGS_OVERRIDE_KEY = 'novajs:settings';
/** localStorage key: the current pilot's profile (name, nickname, ...). */
export const PILOT_PROFILE_KEY = 'novajs:pilot';

/** A minimal storage surface so this is testable without a browser. */
export interface PrefsStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

function getStorage(storage?: PrefsStorage): PrefsStorage | undefined {
    if (storage) {
        return storage;
    }
    try {
        return typeof localStorage !== 'undefined' ? localStorage : undefined;
    } catch {
        return undefined;
    }
}

function readJson<T>(key: string, storage?: PrefsStorage): T | undefined {
    const store = getStorage(storage);
    if (!store) {
        return undefined;
    }
    let raw: string | null;
    try {
        raw = store.getItem(key);
    } catch {
        return undefined;
    }
    if (raw == null) {
        return undefined;
    }
    try {
        return JSON.parse(raw) as T;
    } catch {
        return undefined;
    }
}

function writeJson(key: string, value: unknown, storage?: PrefsStorage): void {
    const store = getStorage(storage);
    if (!store) {
        return;
    }
    try {
        store.setItem(key, JSON.stringify(value));
    } catch {
        // Best effort; ignore quota / disabled-storage failures.
    }
}

/** The player-editable game settings shown on the "Game Settings" tab.
 * Keys mirror the original's toggles; values persist even when a given
 * toggle has no wired effect in this browser build yet. */
export interface GameSettingsOverride {
    shipAnimations?: boolean;
    engineGlows?: boolean;
    runningLights?: boolean;
    weaponEffects?: boolean;
    smokeTrails?: boolean;
    parallaxStarfield?: boolean;
    introMusic?: boolean;
    ambientSounds?: boolean;
    hyperspaceEffects?: boolean;
    /** 'muted' | 'quiet' | 'normal' | 'loud'. */
    soundVolume?: string;
}

/** Loads persisted game-settings overrides (empty object if none). */
export function loadGameSettings(storage?: PrefsStorage): GameSettingsOverride {
    return readJson<GameSettingsOverride>(SETTINGS_OVERRIDE_KEY, storage) ?? {};
}

/** Persists the game-settings overrides. */
export function saveGameSettings(settings: GameSettingsOverride,
    storage?: PrefsStorage): void {
    writeJson(SETTINGS_OVERRIDE_KEY, settings, storage);
}

/**
 * Control-binding overrides: action id -> primary event.code.
 *
 * An empty-string value means "explicitly unbound": the player moved this
 * action's key onto another action, so the served default must NOT come
 * back. `mergeControls` turns it into an empty binding list.
 */
export type ControlsOverride = Record<string, string>;

/** Loads persisted control-binding overrides (empty object if none). */
export function loadControlsOverride(storage?: PrefsStorage): ControlsOverride {
    return readJson<ControlsOverride>(CONTROLS_OVERRIDE_KEY, storage) ?? {};
}

/** Persists control-binding overrides. */
export function saveControlsOverride(controls: ControlsOverride,
    storage?: PrefsStorage): void {
    writeJson(CONTROLS_OVERRIDE_KEY, controls, storage);
}

/**
 * Merges control-binding overrides over a base `controls.json` object
 * (as served by the server). Each overridden action replaces that
 * action's binding with the single overridden key. Actions the player
 * never touched keep their served default. Returns a new object; the
 * base is not mutated.
 */
export function mergeControls(base: Record<string, unknown>,
    override: ControlsOverride): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base };
    for (const [action, code] of Object.entries(override)) {
        // '' means the player deliberately unbound this action (its key
        // was reassigned elsewhere). An empty list is a valid
        // ControlInputs value, so the action ends up with no key at all
        // rather than silently reverting to its served default.
        merged[action] = code ? code : [];
    }
    return merged;
}

/**
 * Records "bind `action` to `code`" in an override map, taking the key
 * away from whichever other rebindable action currently owns it.
 *
 * Without this displacement the new binding is unusable: `getActions`
 * returns every action bound to a code, so e.g. rebinding Fire Secondary
 * onto the Hyper Jump key made that key both fire and jump. Only actions
 * the editor itself exposes are displaced — menu/spaceport actions
 * (up/down/accept, bar/buy/sell, ...) intentionally share keys with
 * flight controls because they are live in different contexts.
 *
 * Returns a new map; the input is not mutated.
 */
export function bindControl(base: Record<string, unknown>,
    override: ControlsOverride, action: string, code: string,
    rebindableActions: readonly string[]): ControlsOverride {
    const next: ControlsOverride = { ...override, [action]: code };
    if (!code) {
        return next;
    }
    for (const other of rebindableActions) {
        if (other === action) {
            continue;
        }
        if (primaryBinding(other, base, next) === code) {
            next[other] = '';
        }
    }
    return next;
}

/**
 * The event.code an action is currently bound to: the override if it has
 * one (including '' for explicitly unbound), else the first key of the
 * served default.
 */
export function primaryBinding(action: string, base: Record<string, unknown>,
    override: ControlsOverride): string {
    if (Object.prototype.hasOwnProperty.call(override, action)) {
        return override[action];
    }
    const raw = base[action];
    if (typeof raw === 'string') {
        return raw;
    }
    if (Array.isArray(raw) && typeof raw[0] === 'string') {
        return raw[0] as string;
    }
    if (raw && typeof raw === 'object'
        && typeof (raw as { key?: string }).key === 'string') {
        return (raw as { key: string }).key;
    }
    return '';
}

/** A pilot's identity, entered in the "New Pilot" dialog. */
export interface PilotProfile {
    /** The pilot's full name (e.g. "Shane Merrol"). */
    name: string;
    /** The pilot's short nickname (e.g. "Hawkeye"). */
    nickname: string;
    /** 'male' | 'female'. */
    gender: string;
    /** Strict play: permadeath (no reincarnation). */
    strict: boolean;
    /** A stable ship hull number for the "Ship Name" display line. */
    shipNumber?: number;
}

/** Loads the current pilot profile, if one has been created. */
export function loadPilotProfile(storage?: PrefsStorage):
    PilotProfile | undefined {
    return readJson<PilotProfile>(PILOT_PROFILE_KEY, storage);
}

/** Persists the current pilot profile. */
export function savePilotProfile(profile: PilotProfile,
    storage?: PrefsStorage): void {
    writeJson(PILOT_PROFILE_KEY, profile, storage);
}

/** Clears the current pilot profile (new-pilot/reset). */
export function clearPilotProfile(storage?: PrefsStorage): void {
    const store = getStorage(storage);
    if (!store) {
        return;
    }
    try {
        store.removeItem(PILOT_PROFILE_KEY);
    } catch {
        // Ignore.
    }
}
