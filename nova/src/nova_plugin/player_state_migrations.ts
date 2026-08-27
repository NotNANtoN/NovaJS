import {
    createInitialPlayerState,
    PersistentPlayerState,
    toPersistentPlayerState,
} from './player_state';

export const CURRENT_PLAYER_RECORD_SCHEMA_VERSION = 1;

type UnknownRecord = Record<string, unknown>;

export interface PlayerRecordMigration {
    readonly fromVersion: number;
    readonly toVersion: number;
    readonly migrate: (value: unknown) => unknown;
}

export type PlayerRecordMigrationResult =
    | {
        readonly kind: 'current';
        readonly value: unknown;
    }
    | {
        readonly kind: 'future';
        readonly version: number;
    }
    | {
        readonly kind: 'invalid-version';
    };

const DEFAULTED_PLAYER_FIELDS = [
    'cargoCapacity',
    'holds',
    'pilotName',
    'shipName',
    'gender',
    'lastLandedPlanet',
    'lastLandedPosition',
    'destroyedStellars',
    'activeRanks',
    'exploredSystems',
    'kills',
    'fuel',
    'legalRecords',
    'registered',
] as const satisfies ReadonlyArray<keyof PersistentPlayerState>;

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value);
}

function migrateMissionCargo(value: UnknownRecord): UnknownRecord {
    if (!Array.isArray(value.activeMissions)
        || !Array.isArray(value.holds)) {
        return value;
    }
    const holds = [...value.holds];
    for (const mission of value.activeMissions) {
        if (!isRecord(mission)
            || mission.state !== 'active'
            || typeof mission.missionId !== 'string'
            || !isRecord(mission.cargo)
            || typeof mission.cargo.quantity !== 'number'
            || mission.cargo.quantity <= 0
            || holds.some(hold => isRecord(hold)
                && hold.isMissionCargo === true
                && hold.commodity === mission.missionId)) {
            continue;
        }
        holds.push({
            commodity: mission.missionId,
            tons: mission.cargo.quantity,
            isMissionCargo: true,
        });
    }
    return {
        ...value,
        holds,
    };
}

function migratePlayerState(value: unknown): unknown {
    if (!isRecord(value)) {
        return value;
    }
    const defaults = toPersistentPlayerState(
        createInitialPlayerState(),
    ) as unknown as UnknownRecord;
    const migrated: UnknownRecord = { ...value };
    for (const field of DEFAULTED_PLAYER_FIELDS) {
        if (!(field in migrated)) {
            migrated[field] = defaults[field];
        }
    }
    if (!('lastLandedSystem' in migrated)) {
        migrated.lastLandedSystem =
            typeof migrated.currentSystem === 'string'
                ? migrated.currentSystem
                : defaults.lastLandedSystem;
    }
    return migrateMissionCargo(migrated);
}

function migrateSnapshot(value: unknown): unknown {
    if (!isRecord(value)) {
        return value;
    }
    return {
        ...value,
        state: migratePlayerState(value.state),
    };
}

export function migratePlayerRecordV0ToV1(value: unknown): unknown {
    if (!isRecord(value)) {
        return value;
    }
    return {
        ...migratePlayerState(value) as UnknownRecord,
        schemaVersion: 1,
        snapshots: Array.isArray(value.snapshots)
            ? value.snapshots.map(migrateSnapshot)
            : value.snapshots ?? [],
    };
}

export const PLAYER_RECORD_MIGRATIONS:
ReadonlyArray<PlayerRecordMigration> = [
    {
        fromVersion: 0,
        toVersion: 1,
        migrate: migratePlayerRecordV0ToV1,
    },
];

export function migratePlayerRecord(
    value: unknown,
): PlayerRecordMigrationResult {
    if (!isRecord(value)) {
        return { kind: 'invalid-version' };
    }
    const rawVersion = value.schemaVersion;
    if (rawVersion !== undefined
        && (!Number.isInteger(rawVersion) || (rawVersion as number) < 0)) {
        return { kind: 'invalid-version' };
    }
    let version = rawVersion === undefined ? 0 : rawVersion as number;
    if (version > CURRENT_PLAYER_RECORD_SCHEMA_VERSION) {
        return { kind: 'future', version };
    }
    let migrated: unknown = value;
    while (version < CURRENT_PLAYER_RECORD_SCHEMA_VERSION) {
        const migration = PLAYER_RECORD_MIGRATIONS.find(
            candidate => candidate.fromVersion === version);
        if (!migration) {
            return { kind: 'invalid-version' };
        }
        migrated = migration.migrate(migrated);
        version = migration.toVersion;
    }
    return {
        kind: 'current',
        value: migrated,
    };
}
