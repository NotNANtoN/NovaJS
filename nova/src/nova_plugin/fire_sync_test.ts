import { Entity } from 'nova_ecs/entity';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import {
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
        expect(state.highestIntentSeq).toBe(6);
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
