import { isLeft } from 'fp-ts/lib/Either.js';
import * as t from 'io-ts';
import { Entity } from 'nova_ecs/entity';
import { CargoComponent } from './cargo_plugin.js';
import { ControlBitsComponent } from './ncb_plugin.js';
import { OutfitsStateComponent } from './outfit_plugin.js';
import {
    ActiveMissionType,
    CreditsComponent,
    CronStatesComponent,
    CronStateType,
    GameDateComponent,
    GameDateType,
    MissionsComponent,
} from './player_state_plugin.js';
import { CombatRatingComponent, LegalRecordsComponent } from './reputation_plugin.js';
import { ShipComponent } from './ship_plugin.js';

/**
 * Persistent save game for the local player.
 *
 * The save is a read-only observer of the simulation: it serializes the
 * components that already live on the player's ship entity (ship type and
 * outfits) plus the id of the system the player is currently in. Restoring
 * happens through the same path that spawns the player's ship at game start,
 * so nothing here mutates sim state mid-game.
 *
 * The schema is versioned: a top-level `version` plus a `data` payload. When
 * a stored save can't be decoded (corrupt, or written by a newer/older
 * version whose shape we don't understand), it is moved to a quarantine key
 * rather than deleted, and the game falls back to its defaults.
 */

/** Bump when the shape of `SaveData` changes incompatibly. */
export const SAVE_VERSION = 1;

/** Stable localStorage key holding the current save. */
export const SAVE_KEY = 'novajs:save';

/** Where an unreadable save is parked instead of being deleted. */
export const SAVE_QUARANTINE_KEY = 'novajs:save:quarantine';

/**
 * An owned outfit and how many of it the player has. Encoded as a
 * `[outfitId, count]` tuple to mirror how `OutfitsStateComponent` is
 * serialized (a JSON-safe array of entries).
 */
export const SavedOutfit = t.tuple([
    t.string, // Outfit nova id.
    t.number, // Count.
]);
export type SavedOutfit = t.TypeOf<typeof SavedOutfit>;

/**
 * The player state we persist.
 *
 * `ship`, `outfits`, and `system` exist in the simulation today and are
 * always written. The optional fields cover gameplay state that may be
 * absent (older saves keep loading because they are `t.partial`):
 * credits, the game date, active missions with their runtime state,
 * mission/scooped cargo, control bits, cron progress, legal records
 * (reputations), and the combat rating.
 */
export const SaveData = t.intersection([
    t.type({
        // Nova id of the player's ship type (e.g. 'nova:164').
        ship: t.string,
        // Owned outfits with counts.
        outfits: t.array(SavedOutfit),
        // Nova id of the system the player is in (e.g. 'nova:130').
        system: t.string,
    }),
    t.partial({
        credits: t.number,
        // The player's calendar date.
        date: GameDateType,
        // Active missions and their runtime state, keyed by mission id.
        missions: t.array(t.tuple([t.string, ActiveMissionType])),
        // Set Nova control bits, keyed by decimal bit id ("342").
        // The number is unused (always 1); the shape predates this
        // field being written and stays for compatibility.
        novaControlBits: t.array(t.tuple([t.string, t.number])),
        // Cargo aboard: commodity key ('mission:<id>', 'cargo:<n>',
        // 'junk:<id>') -> tons.
        cargo: t.array(t.tuple([t.string, t.number])),
        // Per-cron progress, keyed by cron id.
        cronStates: t.array(t.tuple([t.string, CronStateType])),
        // Legal records, keyed by gövt id ('nova:128'). A govt absent
        // here reads as its InitialRec (see reputation.ts).
        reputations: t.array(t.tuple([t.string, t.number])),
        // Combat ratings, keyed by category; 'kills' holds the
        // Appendix I kill points.
        combatRatings: t.array(t.tuple([t.string, t.number])),
    }),
]);
export type SaveData = t.TypeOf<typeof SaveData>;

/** The versioned envelope actually stored in localStorage. */
export const SaveEnvelope = t.type({
    version: t.number,
    data: SaveData,
});
export type SaveEnvelope = t.TypeOf<typeof SaveEnvelope>;

/**
 * Builds a save payload from the player's ship entity and the id of the
 * system it is in. Reads existing components; does not mutate the entity.
 * Returns undefined if the entity is missing the ship type, in which case
 * there is nothing meaningful to persist.
 */
export function extractSaveData(entity: Entity, systemId: string):
    SaveData | undefined {
    const ship = entity.components.get(ShipComponent);
    if (!ship) {
        return undefined;
    }
    const outfitsState = entity.components.get(OutfitsStateComponent);
    const outfits: SavedOutfit[] = outfitsState
        ? [...outfitsState].map(([id, { count }]) => [id, count])
        : [];
    const save: SaveData = {
        ship: ship.id,
        outfits,
        system: systemId,
    };

    const credits = entity.components.get(CreditsComponent);
    if (credits) {
        save.credits = credits.credits;
    }
    const date = entity.components.get(GameDateComponent);
    if (date) {
        save.date = date;
    }
    const missions = entity.components.get(MissionsComponent);
    if (missions) {
        save.missions = [...missions];
    }
    const bits = entity.components.get(ControlBitsComponent);
    if (bits) {
        save.novaControlBits = [...bits].map(bit => [String(bit), 1]);
    }
    const cargo = entity.components.get(CargoComponent);
    if (cargo) {
        save.cargo = [...cargo];
    }
    const cronStates = entity.components.get(CronStatesComponent);
    if (cronStates) {
        save.cronStates = [...cronStates];
    }
    const records = entity.components.get(LegalRecordsComponent);
    if (records) {
        save.reputations = [...records];
    }
    const rating = entity.components.get(CombatRatingComponent);
    if (rating) {
        save.combatRatings = [['kills', rating.kills]];
    }
    return save;
}

/**
 * Applies the optional player-state fields of a save onto the player
 * entity's components. The required fields (ship/outfits/system) are
 * consumed by the spawn path in browser.ts; this handles the rest.
 */
export function restorePlayerState(entity: Entity, save: SaveData): void {
    if (save.credits !== undefined) {
        entity.components.set(CreditsComponent, { credits: save.credits });
    }
    if (save.date) {
        entity.components.set(GameDateComponent, { ...save.date });
    }
    if (save.missions) {
        entity.components.set(MissionsComponent, new Map(
            save.missions.map(([id, mission]) => [id, { ...mission }])));
    }
    if (save.novaControlBits) {
        entity.components.set(ControlBitsComponent, new Set(
            save.novaControlBits
                .map(([bit]) => parseInt(bit, 10))
                .filter(bit => !Number.isNaN(bit))));
    }
    if (save.cargo) {
        entity.components.set(CargoComponent, new Map(save.cargo));
    }
    if (save.cronStates) {
        entity.components.set(CronStatesComponent, new Map(
            save.cronStates.map(([id, state]) => [id, { ...state }])));
    }
    if (save.reputations) {
        entity.components.set(LegalRecordsComponent,
            new Map(save.reputations));
    }
    if (save.combatRatings) {
        const kills = save.combatRatings
            .find(([category]) => category === 'kills')?.[1];
        if (kills !== undefined) {
            entity.components.set(CombatRatingComponent, { kills });
        }
    }
}

/** Wraps a payload in the current versioned envelope. */
export function makeEnvelope(data: SaveData): SaveEnvelope {
    return { version: SAVE_VERSION, data };
}

/** Serializes an envelope to the JSON string stored in localStorage. */
export function encodeSave(data: SaveData): string {
    return JSON.stringify(SaveEnvelope.encode(makeEnvelope(data)));
}

/**
 * Parses and validates a stored save string.
 *
 * Returns the decoded `SaveData` on success. Returns undefined for any
 * unreadable input — malformed JSON, wrong shape, or a version this build
 * doesn't understand — so callers can fall back to defaults. Never throws.
 */
export function decodeSave(raw: string | null | undefined):
    SaveData | undefined {
    if (raw == null) {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    const envelope = SaveEnvelope.decode(parsed);
    if (isLeft(envelope)) {
        return undefined;
    }
    if (envelope.right.version !== SAVE_VERSION) {
        // A save from a different (older or newer) schema version. We only
        // know how to read the current one; treat anything else as
        // unreadable so it gets quarantined rather than misinterpreted.
        return undefined;
    }
    return envelope.right.data;
}

/**
 * A minimal storage surface so this module is testable without a browser.
 * `localStorage` satisfies it.
 */
export interface SaveStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

function getStorage(storage?: SaveStorage): SaveStorage | undefined {
    if (storage) {
        return storage;
    }
    try {
        return typeof localStorage !== 'undefined' ? localStorage : undefined;
    } catch {
        // Accessing localStorage can throw (e.g. disabled cookies).
        return undefined;
    }
}

/**
 * Loads the save from storage. If a save is present but unreadable, it is
 * moved to the quarantine key (preserving the bad data for inspection) and
 * undefined is returned so the game starts from defaults.
 */
export function loadSave(storage?: SaveStorage): SaveData | undefined {
    const store = getStorage(storage);
    if (!store) {
        return undefined;
    }
    let raw: string | null;
    try {
        raw = store.getItem(SAVE_KEY);
    } catch {
        return undefined;
    }
    if (raw == null) {
        return undefined;
    }
    const data = decodeSave(raw);
    if (data === undefined) {
        // Park the unreadable save instead of dropping it silently.
        try {
            store.setItem(SAVE_QUARANTINE_KEY, raw);
            store.removeItem(SAVE_KEY);
        } catch {
            // Best effort; ignore storage failures.
        }
        console.warn(
            `Ignoring an unreadable save (moved to '${SAVE_QUARANTINE_KEY}').`);
        return undefined;
    }
    return data;
}

/** Writes a save payload to storage. Never throws. */
export function writeSave(data: SaveData, storage?: SaveStorage): void {
    const store = getStorage(storage);
    if (!store) {
        return;
    }
    try {
        store.setItem(SAVE_KEY, encodeSave(data));
    } catch (e) {
        console.warn('Failed to write save', e);
    }
}

/** Clears the current save (leaves any quarantined save alone). */
export function resetSave(storage?: SaveStorage): void {
    const store = getStorage(storage);
    if (!store) {
        return;
    }
    try {
        store.removeItem(SAVE_KEY);
    } catch {
        // Ignore.
    }
}
