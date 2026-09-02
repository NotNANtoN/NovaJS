import { World } from 'nova_ecs/world';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { MultiplayerData, CommunicatorResource } from 'nova_ecs/plugins/multiplayer_plugin';
import { MockCommunicator } from 'nova_ecs/plugins/mock_communicator';
import { PlatformResource } from './platform_plugin';
import { WeaponsStateComponent } from './weapons_state';
import { DefaultMap } from 'nova_ecs/utils';
import { getDefaultWeaponLocalState, WeaponsComponent, WeaponEntries, WeaponEntry } from './fire_weapon_plugin';
import { WeaponsSystem, ServerFireIntentSystem, FireLogSpawnSystem } from './weapon_plugin';
import { FireIntentComponent, FireLogComponent, FireSyncPlugin } from './fire_sync';
import { getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { Gettable } from 'novadatainterface/Gettable';
import { Entity } from 'nova_ecs/entity';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import {
    FireIntentShot,
    fireLogReplayTiming,
    getFireSyncLocalState,
    loggedShotEntityId,
    makeFireLogShot,
    pushShot, appendShot, newShotsAfter } from './fire_sync';

interface TestShot {
    seq: number;
    value: string;
}

function shot(seq: number, value = `${seq}`): TestShot {
    return { seq, value };
}

describe('fire sync buffers', () => {
    it('retains only the newest entries past the bound', () => {
        let shots: TestShot[] = [];
        for (let seq = 1; seq <= 6; seq++) {
            shots = appendShot(shots, shot(seq), 4);
        }
        expect(shots.map(entry => entry.seq)).toEqual([3, 4, 5, 6]);
    });

    it('replaces a duplicate sequence without duplicating it', () => {
        const shots = appendShot(
            [shot(1), shot(2, 'old')],
            shot(2, 'new'),
        );
        expect(shots).toEqual([shot(1), shot(2, 'new')]);
        expect(newShotsAfter([...shots, shot(2, 'duplicate')], 1))
            .toEqual([shot(2, 'duplicate')]);
    });

    it('returns new entries across a sequence gap', () => {
        expect(newShotsAfter([shot(4), shot(7)], 3)
            .map(entry => entry.seq)).toEqual([4, 7]);
    });

    it('sorts an out-of-order arrival and ignores stale entries', () => {
        expect(newShotsAfter(
            [shot(8), shot(5), shot(7), shot(6)],
            5,
        ).map(entry => entry.seq)).toEqual([6, 7, 8]);
    });
});

describe('adopting a buffer a world was not watching for', () => {
    it('replays the live log tail so observers see in-flight shots', () => {
        const log = {
            shots: [4, 5, 6].map(seq => ({
                seq,
                weaponId: 'nova:128',
                seed: 0,
                exitIndex: 0,
                at: 0,
                position: undefined as never,
                rotation: undefined as never,
            })),
        };
        const state = getFireSyncLocalState(new Entity('ship'), undefined, log);

        expect(newShotsAfter(log.shots, state.highestLogSeq)
            .map(shot => shot.seq))
            .withContext('NPC FireLog is the only way observers see shots')
            .toEqual([4, 5, 6]);
        expect(state.nextSeq).toBe(7);
        expect(state.highestIntentSeq).toBe(0);
    });

    it('still starts from the beginning for a ship that has not fired', () => {
        const state = getFireSyncLocalState(new Entity('ship'));
        expect(state.highestLogSeq).toBe(0);
        expect(state.nextSeq).toBe(1);
    });
});

describe('appending a shot in place', () => {
    it('keeps the same array so the wire sees one added entry', () => {
        const shots = [{ seq: 1 }, { seq: 2 }];
        expect(pushShot(shots, { seq: 3 }, 3)).toBe(shots);
        expect(shots.map(shot => shot.seq)).toEqual([1, 2, 3]);
    });

    it('drops the oldest entry past the bound', () => {
        const shots = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
        pushShot(shots, { seq: 4 }, 3);
        expect(shots.map(shot => shot.seq)).toEqual([2, 3, 4]);
    });

    it('replaces a repeated sequence rather than growing', () => {
        const shots = [{ seq: 1 }, { seq: 2 }];
        pushShot(shots, { seq: 2 }, 3);
        expect(shots.map(shot => shot.seq)).toEqual([1, 2]);
    });
});

describe('fire log replay timing', () => {
    it('fast-forwards by the age of the logged shot', () => {
        expect(fireLogReplayTiming(1_000, 1_250, 2_000)).toEqual({
            expired: false,
            createdAt: 1_000,
            fastForwardMs: 250,
        });
    });

    it('does not rewind a shot that has not been fired yet locally', () => {
        expect(fireLogReplayTiming(1_000, 900, 2_000)).toEqual({
            expired: false,
            createdAt: 1_000,
            fastForwardMs: 0,
        });
    });

    it('skips a shot whose lifetime has already elapsed', () => {
        expect(fireLogReplayTiming(1_000, 3_000, 1_500).expired).toBeTrue();
    });
});

describe('logged shot identity', () => {
    it('is stable for the same source and sequence', () => {
        expect(loggedShotEntityId('ship-a', 7))
            .toBe(loggedShotEntityId('ship-a', 7));
        expect(loggedShotEntityId('ship-a', 7))
            .not.toBe(loggedShotEntityId('ship-b', 7));
    });

    it('records source velocity and target on the logged shot', () => {
        const logged = makeFireLogShot(
            { seq: 3, weaponId: 'nova:128', seed: 9, exitIndex: 1 },
            500,
            new Position(10, 20),
            new Angle(0.5),
            {
                sourceVelocity: new Vector(3, -4),
                target: 'victim',
                inaccuracy: 0.02,
            },
        );
        expect(logged.sourceVelocity).toEqual(new Vector(3, -4));
        expect(logged.target).toBe('victim');
        expect(logged.inaccuracy).toBe(0.02);
        expect(logged.position).toEqual(new Position(10, 20));
    });
});

describe('fire intent target', () => {
    it('decodes the optional target field', () => {
        const decoded = FireIntentShot.decode({
            seq: 4,
            weaponId: 'nova:128',
            seed: 12,
            exitIndex: 0,
            target: 'victim',
        });

        expect(decoded._tag).toBe('Right');
        if (decoded._tag === 'Right') {
            expect(decoded.right.target).toBe('victim');
        }
    });
});

describe('end-to-end shot synchronization across client, server, and observers', () => {
    function makeTestWeapon(onFire: (source: string, seed: number) => void, onFireLog: (source: string, seq: number) => void) {
        const data = getDefaultProjectileWeaponData();
        data.id = 'blaster-128';
        data.reload = 100;
        data.accuracy = 0;
        const entry = {
            data,
            syncAsFireEvent: true,
            fireFromEntityDetailed: (source: string, seed: number, _inaccuracy?: boolean, _exitIndex?: number, extras?: { entityId?: string, target?: string }) => {
                onFire(source, seed);
                return {
                    entity: new Entity(extras?.entityId ?? 'shot'),
                    position: new Position(100, 200),
                    rotation: new Angle(0.5),
                    sourceVelocity: new Vector(10, 0),
                    target: extras?.target,
                    inaccuracy: 0,
                };
            },
            fireFromLog: (source: string, shot: any) => {
                onFireLog(source, shot.seq);
                return new Entity(loggedShotEntityId(source, shot.seq));
            },
        } as unknown as WeaponEntry;

        const entries = new Gettable<WeaponEntry | undefined>(async () => entry);
        entries.gotten[data.id] = entry;
        return entries;
    }

    it('correctly syncs shooter intent to server, broadcasts to observer, and avoids duplicate spawn', async () => {
        const clientShots: Array<{ source: string, seed: number }> = [];
        const serverShots: Array<{ source: string, seed: number }> = [];
        const observerSpawnedShots: Array<{ source: string, seq: number }> = [];
        const shooterSpawnedFromLog: Array<{ source: string, seq: number }> = [];

        const clientEntries = makeTestWeapon(
            (s, seed) => clientShots.push({ source: s, seed }),
            (s, seq) => shooterSpawnedFromLog.push({ source: s, seq }),
        );
        const serverEntries = makeTestWeapon(
            (s, seed) => serverShots.push({ source: s, seed }),
            () => {},
        );
        const observerEntries = makeTestWeapon(
            () => {},
            (s, seq) => observerSpawnedShots.push({ source: s, seq }),
        );

        const time = { time: 1000, delta_ms: 16.6, delta_s: 0.0166, frame: 1 };

        // 1. Client A (Shooter)
        const clientWorld = new World('client-a');
        clientWorld.resources.set(PlatformResource, 'browser');
        clientWorld.resources.set(CommunicatorResource, new MockCommunicator('client-a'));
        clientWorld.resources.set(TimeResource, time);
        clientWorld.resources.set(WeaponEntries, clientEntries);
        await clientWorld.addPlugin(DeltaPlugin);
        await clientWorld.addPlugin(FireSyncPlugin);
        clientWorld.addSystem(WeaponsSystem);
        clientWorld.addSystem(FireLogSpawnSystem);

        const shooterShip = new Entity('ship-a')
            .addComponent(MultiplayerData, { owner: 'client-a' })
            .addComponent(WeaponsStateComponent, new Map([['blaster-128', { count: 1, firing: true }]]))
            .addComponent(WeaponsComponent, new DefaultMap(getDefaultWeaponLocalState));
        clientWorld.entities.set('ship-a', shooterShip);

        // Client A steps -> fires shot locally
        clientWorld.step();
        expect(clientShots.length).toBe(1);
        const intent = shooterShip.components.get(FireIntentComponent);
        expect(intent).toBeDefined();
        expect(intent?.shots.length).toBe(1);
        const shotSeq = intent!.shots[0].seq;
        const shotSeed = intent!.shots[0].seed;

        // 2. Server
        const serverWorld = new World('server');
        serverWorld.resources.set(PlatformResource, 'node');
        serverWorld.resources.set(CommunicatorResource, new MockCommunicator('server'));
        serverWorld.resources.set(TimeResource, { time: 1020, delta_ms: 16.6, delta_s: 0.0166, frame: 2 });
        serverWorld.resources.set(WeaponEntries, serverEntries);
        await serverWorld.addPlugin(DeltaPlugin);
        await serverWorld.addPlugin(FireSyncPlugin);
        serverWorld.addSystem(ServerFireIntentSystem);
        serverWorld.addSystem(FireLogSpawnSystem);

        const serverShip = new Entity('ship-a')
            .addComponent(MultiplayerData, { owner: 'client-a' })
            .addComponent(WeaponsStateComponent, new Map([['blaster-128', { count: 1, firing: true }]]))
            .addComponent(FireIntentComponent, { shots: [...intent!.shots] });
        serverWorld.entities.set('ship-a', serverShip);

        // Server steps -> ServerFireIntentSystem processes intent, creates authoritative shot and FireLog
        serverWorld.step();
        expect(serverShots.length).toBe(1);
        expect(serverShots[0].seed).toBe(shotSeed);
        const log = serverShip.components.get(FireLogComponent);
        expect(log).toBeDefined();
        expect(log?.shots.length).toBe(1);
        expect(log?.shots[0].seq).toBe(shotSeq);

        // 3. Observer Client B
        const observerWorld = new World('client-b');
        observerWorld.resources.set(PlatformResource, 'browser');
        observerWorld.resources.set(CommunicatorResource, new MockCommunicator('client-b'));
        observerWorld.resources.set(TimeResource, { time: 1040, delta_ms: 16.6, delta_s: 0.0166, frame: 3 });
        observerWorld.resources.set(WeaponEntries, observerEntries);
        await observerWorld.addPlugin(DeltaPlugin);
        await observerWorld.addPlugin(FireSyncPlugin);
        observerWorld.addSystem(FireLogSpawnSystem);

        const observerShip = new Entity('ship-a')
            .addComponent(MultiplayerData, { owner: 'client-a' })
            .addComponent(FireLogComponent, { shots: [...log!.shots] });
        observerWorld.entities.set('ship-a', observerShip);

        // Observer steps -> FireLogSpawnSystem spawns remote shot
        observerWorld.step();
        expect(observerSpawnedShots.length).toBe(1);
        expect(observerSpawnedShots[0].seq).toBe(shotSeq);

        // 4. Client A (Shooter) receives FireLog back from server
        // Shooter already spawned it locally (seq is in spawnedSeqs), so it must NOT spawn duplicate
        shooterShip.components.set(FireLogComponent, { shots: [...log!.shots] });
        clientWorld.step();
        expect(shooterSpawnedFromLog.length).toBe(0); // Zero duplicates spawned!
    });
});
