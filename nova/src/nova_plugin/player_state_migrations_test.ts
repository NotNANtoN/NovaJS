import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
    createInitialPlayerState,
    PersistentPlayerStateCodec,
    toPersistentPlayerState,
} from './player_state';
import {
    CURRENT_PLAYER_RECORD_SCHEMA_VERSION,
    migratePlayerRecord,
    PLAYER_RECORD_MIGRATIONS,
} from './player_state_migrations';

function fixturePath(name: string): string {
    const root = process.env.NOVAJS_ROOT ?? process.cwd();
    return path.join(
        root,
        'nova',
        'src',
        'nova_plugin',
        'test_fixtures',
        name,
    );
}

describe('player state migrations', () => {
    it('migrates a synthesized v0 record to the current schema', async () => {
        const serialized = await fs.readFile(
            fixturePath('player_record_v0.json'),
            'utf8',
        );
        const fixture = JSON.parse(serialized) as unknown;
        const original = JSON.stringify(fixture);

        const result = migratePlayerRecord(fixture);

        expect(result.kind).toBe('current');
        if (result.kind !== 'current') {
            return;
        }
        const migrated = result.value as Record<string, unknown>;
        expect(migrated.schemaVersion)
            .toBe(CURRENT_PLAYER_RECORD_SCHEMA_VERSION);
        const decoded = PersistentPlayerStateCodec.decode(migrated);
        expect(decoded._tag).toBe('Right');
        if (decoded._tag === 'Right') {
            expect(decoded.right.credits).toBe(4_321);
            expect(decoded.right.lastLandedSystem).toBe('nova:777');
            expect(decoded.right.holds).toContain(jasmine.objectContaining({
                commodity: 'nova:fixture-mission',
                tons: 3,
                isMissionCargo: true,
            }));
        }
        expect(JSON.stringify(fixture)).toBe(original);
    });

    it('takes missing field defaults from the new-pilot state', async () => {
        const serialized = await fs.readFile(
            fixturePath('player_record_v0.json'),
            'utf8',
        );
        const fixture = JSON.parse(serialized) as unknown;
        const result = migratePlayerRecord(fixture);
        const defaults = toPersistentPlayerState(
            createInitialPlayerState(),
        );

        expect(result.kind).toBe('current');
        if (result.kind !== 'current') {
            return;
        }
        const decoded = PersistentPlayerStateCodec.decode(result.value);
        expect(decoded._tag).toBe('Right');
        if (decoded._tag !== 'Right') {
            return;
        }
        expect(decoded.right.cargoCapacity).toBe(defaults.cargoCapacity);
        expect(decoded.right.pilotName).toBe(defaults.pilotName);
        expect(decoded.right.shipName).toBe(defaults.shipName);
        expect(decoded.right.gender).toBe(defaults.gender);
        expect(decoded.right.fuel).toBe(defaults.fuel);
        expect(decoded.right.kills).toBe(defaults.kills);
        expect(decoded.right.legalRecords).toEqual(defaults.legalRecords);
        expect(decoded.right.escorts).toBeUndefined();
        expect(decoded.right.diedAt).toBeUndefined();
    });

    it('keeps the migration registry contiguous and ordered', () => {
        let expectedVersion = 0;
        for (const migration of PLAYER_RECORD_MIGRATIONS) {
            expect(migration.fromVersion).toBe(expectedVersion);
            expect(migration.toVersion).toBe(expectedVersion + 1);
            expectedVersion = migration.toVersion;
        }
        expect(expectedVersion).toBe(CURRENT_PLAYER_RECORD_SCHEMA_VERSION);
    });
});
