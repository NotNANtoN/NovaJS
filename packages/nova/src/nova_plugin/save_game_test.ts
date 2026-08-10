import 'jasmine';
import { MockGameData } from 'novadatainterface/mock_game_data';
import { getDefaultShipData } from 'novadatainterface/ship_data';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import {
    Serializer, SerializerResource,
} from 'nova_ecs/plugins/serializer_plugin';
import { prepareCarriedEscorts } from '../spaceport/landed_escorts.js';
import { BayFighterComponent, ReturnWhenTargetRemovedComponent } from './bay_plugin.js';
import { CargoComponent } from './cargo_plugin.js';
import { completeEntity } from './entity_data_loader.js';
import { EscortCommandComponent } from './escort_command.js';
import { OwnerComponent, SourceComponent } from './fire_weapon_plugin.js';
import { ArmorComponent } from './health_plugin.js';
import { makeShip } from './make_ship.js';
import { makeSystem } from './make_system.js';
import { FormationComponent } from './npc_ai_plugin.js';
import { PlayerEscortComponent } from './player_escort.js';
import { Stat } from './stat.js';
import { ControlBitsComponent } from './ncb_plugin.js';
import { OutfitsState, OutfitsStateComponent } from './outfit_plugin.js';
import { CombatRatingComponent, LegalRecordsComponent } from './reputation_plugin.js';
import {
    CreditsComponent,
    CronStatesComponent,
    GameDateComponent,
    MissionsComponent,
} from './player_state_plugin.js';
import {
    collectEscortsToSave,
    decodeSave,
    encodeSave,
    extractSaveData,
    extractSavedEscorts,
    loadSave,
    resetSave,
    restorePlayerState,
    restoreSavedEscorts,
    RosterEscort,
    SaveData,
    SavedEscort,
    SaveStorage,
    MIN_READABLE_SAVE_VERSION,
    SAVE_KEY,
    SAVE_QUARANTINE_KEY,
    SAVE_VERSION,
    writeSave,
} from './save_game.js';
import { ShipComponent } from './ship_plugin.js';

/** An in-memory SaveStorage for tests. */
class FakeStorage implements SaveStorage {
    readonly items = new Map<string, string>();
    getItem(key: string): string | null {
        return this.items.has(key) ? this.items.get(key)! : null;
    }
    setItem(key: string, value: string): void {
        this.items.set(key, value);
    }
    removeItem(key: string): void {
        this.items.delete(key);
    }
}

const SAMPLE: SaveData = {
    ship: 'nova:164',
    outfits: [['nova:200', 1], ['nova:201', 4]],
    system: 'nova:130',
};

describe('save_game schema', () => {
    it('round-trips a save through encode and decode', () => {
        const decoded = decodeSave(encodeSave(SAMPLE));
        expect(decoded).toEqual(SAMPLE);
    });

    it('round-trips reserved optional fields when present', () => {
        const withReserved: SaveData = {
            ...SAMPLE,
            credits: 12345,
            reputations: [['nova:gov1', -50]],
        };
        const decoded = decodeSave(encodeSave(withReserved));
        expect(decoded).toEqual(withReserved);
    });

    it('extracts ship and outfits from a player entity', () => {
        const entity = new Entity('player');
        entity.components.set(ShipComponent, { id: 'nova:164' });
        const outfits: OutfitsState = new Map([
            ['nova:200', { count: 1 }],
            ['nova:201', { count: 4 }],
        ]);
        entity.components.set(OutfitsStateComponent, outfits);

        const data = extractSaveData(entity, 'nova:130');
        expect(data).toEqual(SAMPLE);
    });

    it('extracts an empty outfit list when the ship has no outfits', () => {
        const entity = new Entity('player');
        entity.components.set(ShipComponent, { id: 'nova:164' });
        const data = extractSaveData(entity, 'nova:131');
        expect(data).toEqual({ ship: 'nova:164', outfits: [], system: 'nova:131' });
    });

    it('returns undefined when the entity has no ship component', () => {
        const entity = new Entity('not a ship');
        expect(extractSaveData(entity, 'nova:130')).toBeUndefined();
    });

    it('round-trips the full player state through extract and restore', () => {
        const entity = new Entity('player');
        entity.components.set(ShipComponent, { id: 'nova:164' });
        entity.components.set(CreditsComponent, { credits: 40000 });
        entity.components.set(GameDateComponent,
            { day: 24, month: 6, year: 1177 });
        entity.components.set(ControlBitsComponent, new Set([13, 342]));
        entity.components.set(CargoComponent, new Map([
            ['mission:nova:128', 10],
            ['cargo:2', 3],
        ]));
        entity.components.set(MissionsComponent, new Map([['nova:128', {
            id: 'nova:128',
            acceptedDay: 430064,
            acceptedAt: 'nova:172',
            travelPlanet: null,
            returnPlanet: 'nova:128',
            cargoType: 2,
            cargoQty: 10,
            cargoLoaded: true,
            travelDone: false,
            deadlineDay: null,
        }]]));
        entity.components.set(CronStatesComponent, new Map([['nova:300', {
            phase: 'active' as const,
            phaseStart: 430064,
            nextEligible: 0,
        }]]));
        entity.components.set(LegalRecordsComponent, new Map([
            ['nova:128', -15],
            ['nova:129', 7],
        ]));
        entity.components.set(CombatRatingComponent, { kills: 420 });

        const saved = extractSaveData(entity, 'nova:130')!;
        // The save must survive the JSON envelope.
        const decoded = decodeSave(encodeSave(saved))!;
        expect(decoded).toEqual(saved);

        const restored = new Entity('restored');
        restored.components.set(ShipComponent, { id: 'nova:164' });
        restorePlayerState(restored, decoded);
        expect(restored.components.get(CreditsComponent))
            .toEqual({ credits: 40000 });
        expect(restored.components.get(GameDateComponent))
            .toEqual({ day: 24, month: 6, year: 1177 });
        expect(restored.components.get(ControlBitsComponent))
            .toEqual(new Set([13, 342]));
        expect(restored.components.get(CargoComponent))
            .toEqual(entity.components.get(CargoComponent)!);
        expect(restored.components.get(MissionsComponent))
            .toEqual(entity.components.get(MissionsComponent)!);
        expect(restored.components.get(CronStatesComponent))
            .toEqual(entity.components.get(CronStatesComponent)!);
        expect(restored.components.get(LegalRecordsComponent))
            .toEqual(entity.components.get(LegalRecordsComponent)!);
        expect(restored.components.get(CombatRatingComponent))
            .toEqual({ kills: 420 });
    });

    it('loads a v1 save written before player state existed', () => {
        // Exactly what an old build wrote: only ship/outfits/system.
        const legacy = JSON.stringify({
            version: SAVE_VERSION,
            data: SAMPLE,
        });
        const decoded = decodeSave(legacy);
        expect(decoded).toEqual(SAMPLE);
        // Restoring applies nothing (fields absent) and doesn't throw.
        const entity = new Entity('restored');
        restorePlayerState(entity, decoded!);
        expect(entity.components.get(CreditsComponent)).toBeUndefined();
    });
});

describe('save_game corrupt/version fallback', () => {
    it('rejects malformed JSON', () => {
        expect(decodeSave('{not json')).toBeUndefined();
    });

    it('rejects a payload with the wrong shape', () => {
        expect(decodeSave(JSON.stringify({
            version: SAVE_VERSION,
            data: { ship: 42 /* should be a string */ },
        }))).toBeUndefined();
    });

    it('rejects a save from a different schema version', () => {
        expect(decodeSave(JSON.stringify({
            version: SAVE_VERSION + 1,
            data: SAMPLE,
        }))).toBeUndefined();
    });

    it('rejects null and empty input', () => {
        expect(decodeSave(null)).toBeUndefined();
        expect(decodeSave(undefined)).toBeUndefined();
    });
});

describe('save_game storage', () => {
    it('writes and loads a save', () => {
        const storage = new FakeStorage();
        writeSave(SAMPLE, storage);
        expect(loadSave(storage)).toEqual(SAMPLE);
    });

    it('quarantines an unreadable save instead of deleting it', () => {
        const storage = new FakeStorage();
        const bad = '{"version":999,"data":{"garbage":true}}';
        storage.setItem(SAVE_KEY, bad);

        expect(loadSave(storage)).toBeUndefined();
        // The bad save is preserved under the quarantine key...
        expect(storage.getItem(SAVE_QUARANTINE_KEY)).toBe(bad);
        // ...and removed from the live key so it isn't retried forever.
        expect(storage.getItem(SAVE_KEY)).toBeNull();
    });

    it('does not quarantine a valid save', () => {
        const storage = new FakeStorage();
        writeSave(SAMPLE, storage);
        loadSave(storage);
        expect(storage.getItem(SAVE_QUARANTINE_KEY)).toBeNull();
    });

    it('reset clears the live save but leaves quarantine alone', () => {
        const storage = new FakeStorage();
        writeSave(SAMPLE, storage);
        storage.setItem(SAVE_QUARANTINE_KEY, 'old bad save');
        resetSave(storage);
        expect(storage.getItem(SAVE_KEY)).toBeNull();
        expect(storage.getItem(SAVE_QUARANTINE_KEY)).toBe('old bad save');
    });

    it('returns undefined when there is no save', () => {
        expect(loadSave(new FakeStorage())).toBeUndefined();
    });
});

/**
 * Escort persistence.
 *
 * These go through the REAL entity serializer (the one a system world
 * builds), because the whole point of storing escorts as encoded entities
 * rather than ship ids is that every registered component survives. A
 * hand-rolled fake codec would assert nothing about that.
 */
const PLAYER = 'player-uuid';
const SHIP_ID = 'test:ship';

function movement(x: number, y: number) {
    return {
        accelerating: 0,
        position: new Position(x, y),
        rotation: new Angle(0),
        turnBack: false,
        turning: 0,
        velocity: new Vector(0, 0),
    };
}

async function makeEscortFixture() {
    const gameData = new MockGameData();
    gameData.data.Ship.map.set(SHIP_ID, {
        ...getDefaultShipData(),
        id: SHIP_ID,
    });
    await gameData.data.Ship.get(SHIP_ID);
    const world = await makeSystem('test:system', gameData, undefined,
        { npcs: false });
    const serializer = world.resources.get(SerializerResource)!;

    async function makeEscort(setup: (ship: Entity) => void = () => { }) {
        const ship = makeShip(gameData.data.Ship.map.get(SHIP_ID)!);
        ship.components.set(MovementStateComponent, movement(500, 500));
        setup(ship);
        await completeEntity(world, ship);
        return ship;
    }

    return { world, serializer, makeEscort };
}

/** The save round trip, end to end, as a helper. */
function saveAndLoad(escorts: SavedEscort[], serializer: Serializer) {
    const stored = encodeSave({ ...SAMPLE, escorts });
    const decoded = decodeSave(stored);
    expect(decoded).toBeDefined();
    return restoreSavedEscorts(decoded!.escorts, serializer);
}

describe('save_game escorts', () => {
    let fixture: Awaited<ReturnType<typeof makeEscortFixture>>;
    beforeAll(async () => {
        fixture = await makeEscortFixture();
    });

    it('round-trips an escort that was IN FLIGHT with the player', async () => {
        const { serializer, makeEscort } = fixture;
        const escort = await makeEscort(ship => {
            ship.components.set(PlayerEscortComponent,
                { player: PLAYER, parent: PLAYER });
            // Battle damage and cargo: the state a ship-id list would lose.
            ship.components.set(ArmorComponent, new Stat({
                current: 23, max: 100, min: 0, recharge: 0,
            }));
            ship.components.set(CargoComponent, new Map([['cargo:2', 5]]));
        });

        // In flight, escorts are live entities in the display world and
        // the client's rosters are empty.
        const toSave = collectEscortsToSave(PLAYER,
            [['escort-1', escort]], []);
        expect(toSave.map(({ uuid }) => uuid)).toEqual(['escort-1']);

        const restored = saveAndLoad(
            extractSavedEscorts(toSave, serializer), serializer);
        expect(restored.length).toBe(1);
        expect(restored[0].uuid).toBe('escort-1');
        expect(restored[0].entity.components.get(ArmorComponent)?.current)
            .toBe(23);
        expect(restored[0].entity.components.get(CargoComponent))
            .toEqual(new Map([['cargo:2', 5]]));
        expect(restored[0].entity.components.get(PlayerEscortComponent))
            .toEqual({ player: PLAYER, parent: PLAYER });
    });

    it('round-trips an escort held on the DOCKED landed roster', async () => {
        const { serializer, makeEscort } = fixture;
        const escort = await makeEscort(ship => {
            ship.components.set(PlayerEscortComponent,
                { player: PLAYER, parent: PLAYER, detached: true });
            ship.components.set(ArmorComponent, new Stat({
                current: 41, max: 100, min: 0, recharge: 0,
            }));
        });
        const landed: RosterEscort[] = [
            { player: PLAYER, uuid: 'landed-1', entity: escort },
        ];

        // Docked: the player and its escorts are out of the world
        // entirely, so the roster is the only source.
        const toSave = collectEscortsToSave(PLAYER, [], [landed]);
        expect(toSave.map(({ uuid }) => uuid)).toEqual(['landed-1']);

        const restored = saveAndLoad(
            extractSavedEscorts(toSave, serializer), serializer);
        expect(restored.length).toBe(1);
        expect(restored[0].entity.components.get(ArmorComponent)?.current)
            .toBe(41);
    });

    it('includes a batch waiting on a carried jump', async () => {
        const { serializer, makeEscort } = fixture;
        const inWorld = await makeEscort(ship => ship.components.set(
            PlayerEscortComponent, { player: PLAYER, parent: PLAYER }));
        const jumping = await makeEscort(ship => ship.components.set(
            PlayerEscortComponent, { player: PLAYER, parent: PLAYER }));
        const carriedJump: RosterEscort[] = [
            { player: PLAYER, uuid: 'jumping-1', entity: jumping },
        ];

        const toSave = collectEscortsToSave(PLAYER, [['in-world-1', inWorld]],
            [[], carriedJump]);
        expect(toSave.map(({ uuid }) => uuid))
            .toEqual(['in-world-1', 'jumping-1']);

        const restored = saveAndLoad(
            extractSavedEscorts(toSave, serializer), serializer);
        expect(restored.map(({ uuid }) => uuid))
            .toEqual(['in-world-1', 'jumping-1']);
    });

    it('writes an escort caught in the landing overlap exactly once',
        async () => {
            const { serializer, makeEscort } = fixture;
            // Mid-landing an escort is on the roster while still present
            // in the world it is flying down through.
            const escort = await makeEscort(ship => ship.components.set(
                PlayerEscortComponent, { player: PLAYER, parent: PLAYER }));
            const roster: RosterEscort[] = [
                { player: PLAYER, uuid: 'both', entity: escort },
            ];
            const toSave = collectEscortsToSave(PLAYER, [['both', escort]],
                [roster]);
            expect(toSave.map(({ uuid }) => uuid)).toEqual(['both']);
            expect(extractSavedEscorts(toSave, serializer).length).toBe(1);
        });

    it('ignores escorts belonging to another player', async () => {
        const { makeEscort } = fixture;
        const mine = await makeEscort(ship => ship.components.set(
            PlayerEscortComponent, { player: PLAYER, parent: PLAYER }));
        const theirs = await makeEscort(ship => ship.components.set(
            PlayerEscortComponent, { player: 'someone-else', parent: 'x' }));
        const roster: RosterEscort[] = [
            { player: 'someone-else', uuid: 'peer-roster', entity: theirs },
        ];
        const toSave = collectEscortsToSave(PLAYER,
            [['mine', mine], ['theirs', theirs]], [roster]);
        expect(toSave.map(({ uuid }) => uuid)).toEqual(['mine']);
    });

    it('keeps a deployed bay fighter\'s identity, and re-links it to its '
        + 'carrier under fresh uuids', async () => {
            const { serializer, makeEscort } = fixture;
            const carrier = await makeEscort(ship => ship.components.set(
                PlayerEscortComponent, { player: PLAYER, parent: PLAYER }));
            const fighter = await makeEscort(ship => {
                // A launched fighter's whole bay identity.
                ship.components.set(BayFighterComponent,
                    { bayWeaponId: 'test:bay' });
                ship.components.set(ReturnWhenTargetRemovedComponent,
                    undefined);
                ship.components.set(OwnerComponent, { owner: 'carrier-uuid' });
                ship.components.set(SourceComponent, 'carrier-uuid');
                ship.components.set(PlayerEscortComponent,
                    { player: PLAYER, parent: 'carrier-uuid' });
            });

            const toSave = collectEscortsToSave(PLAYER, [
                ['carrier-uuid', carrier], ['fighter-uuid', fighter],
            ], []);
            const restored = saveAndLoad(
                extractSavedEscorts(toSave, serializer), serializer);
            expect(restored.length).toBe(2);
            const restoredFighter = restored
                .find(({ uuid }) => uuid === 'fighter-uuid')!;
            expect(restoredFighter.entity.components
                .get(BayFighterComponent)).toEqual({ bayWeaponId: 'test:bay' });
            expect(restoredFighter.entity.components
                .has(ReturnWhenTargetRemovedComponent)).toBeTrue();

            // The restore path is the ordinary carried-batch one, so the
            // fighter must come back attached to its carrier's NEW uuid
            // rather than to the dead pre-save one.
            const leader = new Entity();
            leader.components.set(MovementStateComponent, movement(0, 0));
            let next = 0;
            const prepared = prepareCarriedEscorts(
                restored.map(escort => ({ ...escort, player: PLAYER })),
                PLAYER, leader, 0, () => `fresh-${next++}`);
            expect(prepared.length).toBe(2);
            const newCarrierUuid = prepared
                .find(({ entity }) => entity === restored
                    .find(e => e.uuid === 'carrier-uuid')!.entity)!.uuid;
            const preparedFighter = prepared
                .find(({ entity }) => entity === restoredFighter.entity)!
                .entity;
            expect(newCarrierUuid).not.toBe('carrier-uuid');
            expect(preparedFighter.components.get(SourceComponent))
                .toBe(newCarrierUuid);
            expect(preparedFighter.components.get(OwnerComponent))
                .toEqual({ owner: newCarrierUuid });
            expect(preparedFighter.components.get(FormationComponent)?.leader)
                .toBe(newCarrierUuid);
            // Commands are reset to formation by the same machinery.
            expect(preparedFighter.components.get(EscortCommandComponent))
                .toEqual({ command: 'formation' });
        });

    it('drops only the escort whose entity no longer decodes', async () => {
        const { serializer, makeEscort } = fixture;
        const good = await makeEscort(ship => ship.components.set(
            PlayerEscortComponent, { player: PLAYER, parent: PLAYER }));
        const encoded = extractSavedEscorts(
            collectEscortsToSave(PLAYER, [['good', good]], []), serializer);
        // Structurally a valid blob (EncodedEntity says nothing about a
        // component's payload), but PlayerEscort.player is not a number.
        // This is the entity-codec drift the module comment warns about.
        const rotten: SavedEscort = {
            uuid: 'rotten',
            entity: { components: [['PlayerEscort', { player: 42 }]] },
        };

        const restored = saveAndLoad([...encoded, rotten], serializer);
        expect(restored.map(({ uuid }) => uuid)).toEqual(['good']);
    });

    it('reads a save with no escorts field as zero escorts', () => {
        const { serializer } = fixture;
        const decoded = decodeSave(encodeSave(SAMPLE))!;
        expect(decoded.escorts).toBeUndefined();
        expect(restoreSavedEscorts(decoded.escorts, serializer)).toEqual([]);
    });
});

describe('save_game escort version skew', () => {
    it('loads a v1 save (written before escorts existed) with no escorts',
        () => {
            // Byte for byte what the previous build wrote.
            const v1 = JSON.stringify({
                version: MIN_READABLE_SAVE_VERSION,
                data: SAMPLE,
            });
            expect(MIN_READABLE_SAVE_VERSION).toBeLessThan(SAVE_VERSION);
            const decoded = decodeSave(v1);
            expect(decoded).toEqual(SAMPLE);
            expect(decoded!.escorts).toBeUndefined();
        });

    it('does not quarantine a v1 save', () => {
        const storage = new FakeStorage();
        storage.setItem(SAVE_KEY, JSON.stringify({
            version: MIN_READABLE_SAVE_VERSION,
            data: SAMPLE,
        }));
        expect(loadSave(storage)).toEqual(SAMPLE);
        expect(storage.getItem(SAVE_QUARANTINE_KEY)).toBeNull();
    });

    it('quarantines a save whose escorts are structurally corrupt', () => {
        const storage = new FakeStorage();
        // `escorts` is present but is not an array of {uuid, entity}: the
        // envelope no longer decodes at all, so the WHOLE save is parked
        // rather than dropped, and the game starts from defaults.
        const bad = JSON.stringify({
            version: SAVE_VERSION,
            data: { ...SAMPLE, escorts: [{ uuid: 5, entity: 'nonsense' }] },
        });
        storage.setItem(SAVE_KEY, bad);

        expect(decodeSave(bad)).toBeUndefined();
        expect(loadSave(storage)).toBeUndefined();
        expect(storage.getItem(SAVE_QUARANTINE_KEY)).toBe(bad);
        expect(storage.getItem(SAVE_KEY)).toBeNull();
    });

    it('still quarantines a save from a FUTURE version', () => {
        const storage = new FakeStorage();
        const future = JSON.stringify({
            version: SAVE_VERSION + 1,
            data: SAMPLE,
        });
        storage.setItem(SAVE_KEY, future);
        expect(loadSave(storage)).toBeUndefined();
        expect(storage.getItem(SAVE_QUARANTINE_KEY)).toBe(future);
    });

    it('round-trips escorts through the storage layer', () => {
        const storage = new FakeStorage();
        const escorts: SavedEscort[] = [{
            uuid: 'e1',
            entity: { components: [['Armor', { current: 3 }]], name: 'esc' },
        }];
        writeSave({ ...SAMPLE, escorts }, storage);
        expect(loadSave(storage)?.escorts).toEqual(escorts);
    });
});
