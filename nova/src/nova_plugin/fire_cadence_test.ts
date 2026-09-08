import { FireCadence, FireCadenceOptions, FireCadenceWeapon, FireCadenceShotContext } from './fire_cadence';

const weapon: FireCadenceWeapon = {
    reload: 500, burstReload: 1000, burstCount: 0,
    fireSimultaneously: false, count: 1,
};

function fixture(data: Partial<FireCadenceWeapon> = {}, options: FireCadenceOptions = {}) {
    let now = 0;
    const cadence = new FireCadence<number>(() => now, options);
    cadence.setWeapon('laser', { ...weapon, ...data });
    const shots: { seq: number; at: number }[] = [];
    const drain = () => cadence.drain('laser', (seq, at) => {
        shots.push({ seq, at });
        return true;
    });
    return { cadence, shots, drain, time: (at: number) => { now = at; } };
}

describe('server-local fire cadence', () => {
    for (const simultaneous of [false, true]) {
        it(`exposes stable per-copy burst payment context (simultaneous=${simultaneous})`, () => {
            const f = fixture({ count: 2, burstCount: 2, fireSimultaneously: simultaneous });
            for (let seq = 1; seq <= 6; seq++) f.cadence.enqueue('laser', seq);
            const contexts: FireCadenceShotContext[] = [];
            let failed: FireCadenceShotContext | undefined;
            f.cadence.drain('laser', (_seq, _at, context) => { failed = context; return false; });
            const drain = () => f.cadence.drain('laser', (_seq, _at, context) => {
                contexts.push(context);
                return true;
            });
            drain();
            if (!simultaneous) { f.time(250); drain(); }
            f.time(500); drain();
            if (!simultaneous) { f.time(750); drain(); }
            expect(contexts[0]).toEqual(failed!);
            expect(contexts.slice(0, 4)).toEqual([
                { copy: 0, burstToken: 1, firstInBurst: true, lastInBurst: false },
                { copy: 1, burstToken: 1, firstInBurst: true, lastInBurst: false },
                { copy: 0, burstToken: 1, firstInBurst: false, lastInBurst: true },
                { copy: 1, burstToken: 1, firstInBurst: false, lastInBurst: true },
            ]);
            f.time(simultaneous ? 1500 : 1750); drain();
            expect(contexts[4]).toEqual({ copy: 0, burstToken: 2, firstInBurst: true, lastInBurst: false });
        });
    }

    it('retains the final salvo token across split arrivals and lifecycle clearing', () => {
        const f = fixture({ count: 2, burstCount: 1, fireSimultaneously: true });
        const contexts: FireCadenceShotContext[] = [];
        const drain = () => f.cadence.drain('laser', (_seq, _at, context) => {
            contexts.push(context); return true;
        });
        f.cadence.enqueue('laser', 1); drain();
        f.time(50);
        f.cadence.enqueue('laser', 2); drain();
        expect(contexts.map(c => [c.copy, c.burstToken])).toEqual([[0, 1], [1, 1]]);
        f.cadence.clearPending();
        f.cadence.enqueue('laser', 3);
        f.time(1000); drain();
        expect(contexts[2].burstToken).toBe(2);
    });
    it('queues a realistic 250ms network batch and emits on server time', () => {
        const f = fixture({ reload: 100 });
        f.time(250);
        for (const seq of [1, 2, 3]) {
            expect(f.cadence.enqueue('laser', seq)).toBe('queued');
        }
        expect(f.drain()).toBe(1);
        f.time(349);
        expect(f.drain()).toBe(0);
        f.time(350);
        expect(f.drain()).toBe(1);
        f.time(450);
        expect(f.drain()).toBe(1);
        expect(f.shots).toEqual([
            { seq: 1, at: 250 }, { seq: 2, at: 350 }, { seq: 3, at: 450 },
        ]);
    });

    it('500ms reload never gains extra sustained shots from flooding or repeat drains', () => {
        const f = fixture();
        for (let at = 0; at <= 5000; at += 10) {
            f.time(at);
            for (let i = 0; i < 20; i++) {
                f.cadence.enqueue('laser', at + i);
            }
            f.drain();
            expect(f.drain()).toBe(0);
            expect(f.cadence.pendingCount('laser')).toBeLessThanOrEqual(16);
        }
        expect(f.shots.map(shot => shot.at)).toEqual([
            0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000,
        ]);
    });

    it('does not bank idle or stalled-server catch-up credit', () => {
        const f = fixture({}, { maxAgeMs: 20000 });
        f.cadence.enqueue('laser', 1);
        f.drain();
        f.cadence.enqueue('laser', 2);
        f.cadence.enqueue('laser', 3);
        f.time(10000);
        expect(f.drain()).toBe(1);
        expect(f.drain()).toBe(0);
        f.time(10499);
        expect(f.drain()).toBe(0);
        f.time(10500);
        expect(f.drain()).toBe(1);
    });

    it('staggered installed copies use reload/count and count-scaled burst size', () => {
        const f = fixture({ count: 2, burstCount: 2 });
        for (let seq = 1; seq <= 5; seq++) f.cadence.enqueue('laser', seq);
        for (const at of [0, 250, 500, 750]) {
            f.time(at);
            expect(f.drain()).toBe(1);
        }
        f.time(1000);
        expect(f.drain()).toBe(0);
        f.time(1749);
        expect(f.drain()).toBe(0);
        f.time(1750);
        expect(f.drain()).toBe(1);
    });

    it('enforces burstReload from the final shot, including across batches', () => {
        const f = fixture({ reload: 100, burstCount: 3 });
        for (const seq of [1, 2, 3]) f.cadence.enqueue('laser', seq);
        for (const at of [0, 100, 200]) { f.time(at); f.drain(); }
        f.time(250);
        f.cadence.enqueue('laser', 4);
        f.cadence.enqueue('laser', 5);
        f.time(1199);
        expect(f.drain()).toBe(0);
        f.time(1200);
        expect(f.drain()).toBe(1);
        f.time(1300);
        expect(f.drain()).toBe(1);
        expect(f.shots.map(shot => shot.at)).toEqual([0, 100, 200, 1200, 1300]);
    });

    it('simultaneous salvos consume individual intents and count as one burst opportunity', () => {
        const f = fixture({ count: 3, fireSimultaneously: true, burstCount: 2 });
        for (let seq = 1; seq <= 9; seq++) f.cadence.enqueue('laser', seq);
        expect(f.drain()).toBe(3);
        expect(f.drain()).toBe(0);
        f.time(500);
        expect(f.drain()).toBe(3);
        f.time(1499);
        expect(f.drain()).toBe(0);
        f.time(1500);
        expect(f.drain()).toBe(3);
        expect(f.shots.map(shot => shot.at)).toEqual([0, 0, 0, 500, 500, 500, 1500, 1500, 1500]);
    });

    it('allows split salvo arrivals but never banks unused salvo slots', () => {
        const f = fixture({ count: 3, fireSimultaneously: true });
        f.cadence.enqueue('laser', 1);
        expect(f.drain()).toBe(1);
        f.time(50);
        f.cadence.enqueue('laser', 2);
        expect(f.drain()).toBe(1);
        f.time(500);
        for (const seq of [3, 4, 5, 6]) f.cadence.enqueue('laser', seq);
        expect(f.drain()).toBe(3);
        expect(f.drain()).toBe(0);
    });

    it('failed emission retains the intent and does not debit cadence or burst progress', () => {
        const f = fixture({ burstCount: 1 });
        f.cadence.enqueue('laser', 1);
        expect(f.cadence.drain('laser', () => false)).toBe(0);
        expect(f.cadence.pendingCount('laser')).toBe(1);
        f.time(100);
        expect(f.drain()).toBe(1);
        f.cadence.enqueue('laser', 2);
        f.time(1099);
        expect(f.drain()).toBe(0);
        f.time(1100);
        expect(f.drain()).toBe(1);
    });

    it('partial salvo failure spends only successful slots', () => {
        const f = fixture({ count: 3, fireSimultaneously: true });
        for (const seq of [1, 2, 3, 4]) f.cadence.enqueue('laser', seq);
        expect(f.cadence.drain('laser', seq => seq === 1)).toBe(1);
        expect(f.drain()).toBe(2);
        expect(f.drain()).toBe(0);
    });

    it('bounds FIFO backlog and expires by original server receipt, not new traffic', () => {
        const f = fixture({}, { maxPendingPerWeapon: 3, maxAgeMs: 1000 });
        for (const seq of [1, 2, 3]) expect(f.cadence.enqueue('laser', seq)).toBe('queued');
        for (let seq = 4; seq < 10000; seq++) {
            expect(f.cadence.enqueue('laser', seq)).toBe('full');
        }
        f.time(999);
        expect(f.cadence.enqueue('laser', 10000)).toBe('full');
        f.time(1000);
        expect(f.cadence.enqueue('laser', 10001)).toBe('queued');
        expect(f.cadence.pendingCount('laser')).toBe(1);
        f.drain();
        expect(f.shots).toEqual([{ seq: 10001, at: 1000 }]);
    });

    it('expires unavailable shots during drain without a new arrival', () => {
        const f = fixture();
        f.cadence.enqueue('laser', 1);
        f.cadence.drain('laser', () => false);
        f.time(2000);
        expect(f.drain()).toBe(0);
        expect(f.cadence.pendingCount('laser')).toBe(0);
    });

    it('clears lifecycle work without refilling cooldown or resetting burst progress', () => {
        const f = fixture({ reload: 100, burstCount: 2 });
        f.cadence.enqueue('laser', 1);
        f.cadence.enqueue('laser', 2);
        f.drain();
        f.cadence.clearPending();
        expect(f.cadence.pendingCount('laser')).toBe(0);
        f.cadence.enqueue('laser', 3);
        expect(f.drain()).toBe(0);
        f.time(100);
        expect(f.drain()).toBe(1);
        f.cadence.clearPending('laser');
        f.cadence.enqueue('laser', 4);
        f.time(200);
        expect(f.drain()).toBe(0);
        f.time(1100);
        expect(f.drain()).toBe(1);
    });

    it('clearing a partial salvo discards slots without creating a fresh salvo', () => {
        const f = fixture({ count: 3, fireSimultaneously: true });
        f.cadence.enqueue('laser', 1);
        f.drain();
        f.cadence.clearPending();
        f.cadence.enqueue('laser', 2);
        expect(f.drain()).toBe(0);
        f.time(500);
        expect(f.drain()).toBe(1);
    });

    it('disable/reinstall retains cooldown and unchanged configuration retains queued work', () => {
        const f = fixture();
        f.cadence.enqueue('laser', 1);
        f.cadence.setWeapon('laser', weapon);
        expect(f.drain()).toBe(1);
        f.cadence.setWeapon('laser', { ...weapon, count: 0 });
        expect(f.cadence.enqueue('laser', 2)).toBe('unavailable');
        f.cadence.setWeapon('laser', weapon);
        f.cadence.enqueue('laser', 3);
        expect(f.drain()).toBe(0);
        f.time(500);
        expect(f.drain()).toBe(1);
    });

    it('rejects malformed copy counts instead of rounding or granting a default copy', () => {
        const f = fixture();
        for (const count of [NaN, Infinity, -Infinity, -1, 0.5, 257, Number.MAX_SAFE_INTEGER]) {
            expect(() => f.cadence.setWeapon('bad', { ...weapon, count })).toThrowError(RangeError);
            expect(f.cadence.enqueue('bad', 1)).toBe('unavailable');
        }
    });

    it('bounds key state and isolates weapon cooldowns', () => {
        const f = fixture({}, { maxWeapons: 2 });
        f.cadence.setWeapon('other', weapon);
        expect(() => f.cadence.setWeapon('third', weapon)).toThrowError(RangeError);
        f.cadence.enqueue('laser', 1);
        f.cadence.enqueue('other', 2);
        expect(f.drain()).toBe(1);
        expect(f.cadence.drain('other', () => true)).toBe(1);
        expect(f.cadence.enqueue('unknown', 3)).toBe('unavailable');
    });

    it('ignores timestamps in opaque payloads', () => {
        const cadence = new FireCadence<{ at: number }>(() => 100);
        cadence.setWeapon('laser', weapon);
        cadence.enqueue('laser', { at: -1e20 });
        cadence.enqueue('laser', { at: 1e20 });
        expect(cadence.drain('laser', (_, at) => { expect(at).toBe(100); return true; })).toBe(1);
        expect(cadence.drain('laser', () => true)).toBe(0);
    });

    it('bounds zero reload, rejects bad clocks, and prevents callback reentry', () => {
        const f = fixture({ reload: 0 });
        for (const seq of [1, 2]) f.cadence.enqueue('laser', seq);
        expect(() => f.cadence.drain('laser', () => {
            f.cadence.clearPending();
            return true;
        })).toThrowError();
        expect(f.drain()).toBe(1);
        expect(f.drain()).toBe(0);
        f.time(1);
        expect(f.drain()).toBe(1);
        f.time(0);
        expect(() => f.drain()).toThrowError(RangeError);
        f.time(NaN);
        expect(() => f.drain()).toThrowError(RangeError);
    });
});
