import {
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
