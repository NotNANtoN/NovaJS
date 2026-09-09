import 'jasmine';
import { NetworkTiming, PeerClock, MIN_PRESENTATION_DELAY_MS, MAX_PRESENTATION_DELAY_MS } from './network_timing';

function synchronizedTiming() {
    const timing = new NetworkTiming();
    const clock = timing.clock('server');
    const probe = clock.probe(0)!;
    expect(clock.acceptReply({ id: probe.id, receivedAt: 25, sentAt: 25 }, 50)).toBeTrue();
    return timing;
}

describe('round-trip network clock', () => {
    it('separates clock skew from transit and remote processing time', () => {
        const clock = new PeerClock();
        clock.observeArrival(0, 10020);
        expect(clock.offset).toBe(10020);
        const probe = clock.probe(10000)!;
        expect(clock.acceptReply({ id: probe.id, receivedAt: 20, sentAt: 70 }, 10090)).toBeTrue();
        expect(clock.offset).toBe(10000);
        expect(clock.rttMs).toBe(40);
        clock.observeArrival(100, 10200);
        expect(clock.offset).toBe(10000);
    });

    it('prefers low-RTT samples instead of interpreting queueing as clock drift', () => {
        const clock = new PeerClock();
        let probe = clock.probe(0)!;
        clock.acceptReply({ id: probe.id, receivedAt: 20, sentAt: 20 }, 40);
        probe = clock.probe(1000)!;
        clock.acceptReply({ id: probe.id, receivedAt: 1100, sentAt: 1100 }, 1400);
        expect(clock.offset).toBe(0);
        expect(clock.rttMs).toBe(40);
    });

    it('rejects unsolicited, duplicate, invalid and expired clock replies', () => {
        const clock = new PeerClock();
        expect(clock.acceptReply({ id: 42, receivedAt: 10, sentAt: 10 }, 20)).toBeFalse();
        const probe = clock.probe(0)!;
        const reply = { id: probe.id, receivedAt: 10, sentAt: 10 };
        expect(clock.acceptReply(reply, 20)).toBeTrue();
        expect(clock.acceptReply(reply, 20)).toBeFalse();
        const invalid = clock.probe(1000)!;
        expect(clock.acceptReply({ id: invalid.id, receivedAt: Infinity, sentAt: Infinity }, 1020)).toBeFalse();
        const expired = clock.probe(2000)!;
        expect(clock.acceptReply({ id: expired.id, receivedAt: 2010, sentAt: 2010 }, 10000)).toBeFalse();
        expect(clock.offset).toBe(0);
    });

    it('tracks a slower simulation clock rather than aging fresh packets by seconds', () => {
        const clock = new PeerClock();
        for (let now = 0; now < 10000; now += 50) {
            const probe = clock.probe(now);
            if (probe) {
                clock.acceptReply({ id: probe.id, receivedAt: (now + 25) * 0.6, sentAt: (now + 25) * 0.6 }, now + 50);
            }
            clock.advance(now + 50);
            if (now > 2000) {
                expect(clock.rate).toBeCloseTo(0.6, 6);
                expect(clock.offset).toBeCloseTo((now + 50) * 0.4, 6);
            }
        }
        clock.advance(11000);
        expect(clock.offset).toBeCloseTo(4400, 6);
    });

    it('keeps a bounded probe backlog when an old peer does not answer', () => {
        const clock = new PeerClock();
        let sent = 0;
        for (let i = 0; i < 100; i++) if (clock.probe(i * 10)) sent++;
        expect(sent).toBe(4);
        for (let i = 0; i < 100; i++) clock.probe(1000 + i * 250);
        expect(clock.probe(40000)).toBeDefined();
    });
});

describe('adaptive low-latency presentation', () => {
    it('settles at one 30 Hz interval on a stable link', () => {
        const timing = synchronizedTiming();
        for (let i = 0; i < 180; i++) {
            const at = i * 1000 / 30;
            timing.observeServerPacket('server', at, at + 25);
            timing.advance(at + 25);
        }
        expect(timing.delayMs).toBeCloseTo(MIN_PRESENTATION_DELAY_MS, 6);
        expect(timing.presentationDelay(179 * 1000 / 30 + 25)).toBeLessThanOrEqual(50);
        expect(timing.stats.synchronized).toBeTrue();
        expect(timing.stats.rttMs).toBe(50);
    });

    it('grows for jitter, never rewinds, then recovers when the connection settles', () => {
        const timing = synchronizedTiming();
        let lastArrival = 0;
        let cursor = -Infinity;
        let peak = 0;
        for (let i = 0; i < 420; i++) {
            const at = i * 1000 / 30;
            const extra = i < 90 && i % 6 === 0 ? 140 : 0;
            const arrival = Math.max(lastArrival + 1, at + 25 + extra);
            timing.observeServerPacket('server', at, arrival);
            timing.advance(arrival);
            expect(timing.renderTime!).toBeGreaterThanOrEqual(cursor);
            cursor = timing.renderTime!;
            lastArrival = arrival;
            peak = Math.max(peak, timing.delayMs);
        }
        expect(peak).toBeGreaterThan(50);
        expect(peak).toBeLessThanOrEqual(MAX_PRESENTATION_DELAY_MS);
        expect(timing.delayMs).toBeCloseTo(MIN_PRESENTATION_DELAY_MS, 6);
    });

    it('does not let reordered packets inflate jitter', () => {
        const timing = synchronizedTiming();
        timing.observeServerPacket('server', 100, 125);
        timing.observeServerPacket('server', 133, 158);
        timing.observeServerPacket('server', 100, 500);
        expect(timing.jitterMs).toBe(0);
    });

    it('buffers more when physical latency exceeds bounded prediction', () => {
        const timing = synchronizedTiming();
        for (let i = 0; i < 60; i++) {
            const at = i * 1000 / 30;
            timing.observeServerPacket('server', at, at + 200);
            timing.advance(at + 200);
        }
        expect(timing.delayMs).toBeGreaterThan(100);
        expect(timing.delayMs).toBeLessThanOrEqual(200);
    });

    it('resets timing on reconnect and does not replay a long pause', () => {
        const timing = synchronizedTiming();
        timing.advance(0);
        timing.advance(10000);
        expect(timing.presentationDelay(10000)).toBeLessThanOrEqual(50);
        timing.resetPeer('server');
        expect(timing.stats.synchronized).toBeFalse();
        expect(timing.renderTime).toBeUndefined();
    });
});
