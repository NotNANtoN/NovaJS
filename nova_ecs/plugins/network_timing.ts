import { Resource } from '../resource';
import { Phase, System } from '../system';
import { Component } from '../component';
import { Optional } from '../optional';
import { TimeResource, TimeSystem } from './time_plugin';

export const NetworkReceivePhase = new Phase({ name: 'InboundMultiplayerPhase', after: [TimeSystem] });

export const MOVEMENT_SNAPSHOT_INTERVAL_MS = 1000 / 30;
export const MIN_PRESENTATION_DELAY_MS = 1000 / 30;
export const DEFAULT_PRESENTATION_DELAY_MS = 50;
export const MAX_PRESENTATION_DELAY_MS = 200;
export const MAX_MOVEMENT_EXTRAPOLATION_MS = 100;
const MAX_CLOCK_RTT_MS = 5000;

export interface ClockReply {
    id: number;
    receivedAt: number;
    sentAt: number;
}

/** Local minus remote time. Non-draftable: shared by snapshot buffers. */
export class PeerClock {
    offset = 0;
    initialized = false;
    synchronized = false;
    rttMs = 0;
    rate = 1;
    private advancedAt: number | undefined;
    private nextId = 1;
    private nextProbeAt = -Infinity;
    private pending = new Map<number, number>();
    private samples: Array<{ at: number; rtt: number; offset: number }> = [];
    private lastArrivalTime = -Infinity;

    advance(now: number): void {
        if (!Number.isFinite(now)) return;
        if (this.advancedAt !== undefined) {
            this.offset += Math.max(0, now - this.advancedAt) * (1 - this.rate);
        }
        this.advancedAt = now;
    }

    observeArrival(remoteAt: number, localAt: number): void {
        this.advance(localAt);
        if (!Number.isFinite(remoteAt) || !Number.isFinite(localAt)
            || remoteAt <= this.lastArrivalTime) return;
        this.lastArrivalTime = remoteAt;
        if (this.synchronized) return;
        // Compatibility fallback until a probe succeeds. Prefer the least
        // delayed arrival, not a moving average that follows network congestion.
        const sample = localAt - remoteAt;
        this.offset = this.initialized ? Math.min(this.offset, sample) : sample;
        this.initialized = true;
    }

    probe(now: number): { id: number } | undefined {
        if (!Number.isFinite(now) || now < this.nextProbeAt) return;
        for (const [id, at] of this.pending) {
            if (now - at > MAX_CLOCK_RTT_MS) this.pending.delete(id);
        }
        if (this.pending.size >= 8) return;
        const id = this.nextId++;
        this.pending.set(id, now);
        this.nextProbeAt = now + (this.samples.length >= 4 ? 1000 : 250);
        return { id };
    }

    acceptReply(reply: ClockReply, now: number): boolean {
        const sent = this.pending.get(reply.id);
        if (sent === undefined) return false;
        this.pending.delete(reply.id);
        const { receivedAt, sentAt } = reply;
        if (![now, receivedAt, sentAt].every(Number.isFinite)
            || now < sent || sentAt < receivedAt) return false;
        const rtt = now - sent - (sentAt - receivedAt);
        if (rtt < 0 || rtt > MAX_CLOCK_RTT_MS) return false;
        const offset = ((sent - receivedAt) + (now - sentAt)) / 2;
        if (!Number.isFinite(offset)) return false;
        this.samples = this.samples.filter(sample => now - sample.at < 3000);
        // The estimate belongs to the round trip's midpoint, not receipt time.
        this.samples.push({ at: (sent + now) / 2, rtt, offset });
        if (this.samples.length > 16) this.samples.shift();
        const best = this.samples.reduce((a, b) => a.rtt <= b.rtt ? a : b);
        this.rttMs = best.rtt;
        const reliable = this.samples.filter(sample => sample.rtt <= best.rtt + 30);
        if (reliable.length >= 2 && reliable.at(-1)!.at - reliable[0].at >= 100) {
            const weight = (rtt: number) => 1 / Math.max(1, rtt - best.rtt + 1);
            const total = reliable.reduce((sum, sample) => sum + weight(sample.rtt), 0);
            const meanAt = reliable.reduce((sum, sample) => sum + (sample.at - now) * weight(sample.rtt), 0) / total;
            const meanOffset = reliable.reduce((sum, sample) => sum + sample.offset * weight(sample.rtt), 0) / total;
            let covariance = 0;
            let variance = 0;
            for (const sample of reliable) {
                const dt = sample.at - now - meanAt;
                covariance += weight(sample.rtt) * dt * (sample.offset - meanOffset);
                variance += weight(sample.rtt) * dt * dt;
            }
            if (variance > 0 && Number.isFinite(covariance / variance)) {
                this.rate = 1 - Math.max(-1, Math.min(0.9, covariance / variance));
            }
        }
        // Server timestamps are simulation time. Under load that clock can run
        // slower than wall time; treating the growing difference as network lag
        // eventually expires every new projectile. Extrapolate the verified
        // low-RTT anchor using the measured clock rate instead.
        this.offset = best.offset + (now - best.at) * (1 - this.rate);
        this.advancedAt = now;
        this.initialized = true;
        this.synchronized = true;
        return true;
    }
}

function percentile(values: number[], fraction: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * fraction)];
}

/** One presentation cursor per room, shared by remote ships and fire replay. */
export class NetworkTiming {
    readonly clocks = new Map<string, PeerClock>();
    serverPeer = 'server';
    delayMs = DEFAULT_PRESENTATION_DELAY_MS;
    targetDelayMs = DEFAULT_PRESENTATION_DELAY_MS;
    renderTime: number | undefined;
    generation = 0;
    jitterMs = 0;
    extrapolatedEntities = 0;
    sampledEntities = 0;
    private lastNow: number | undefined;
    private lastRemoteAt: number | undefined;
    private lastArrivalAt: number | undefined;
    private arrivals: Array<{ at: number; age: number; jitter: number }> = [];

    clock(peer: string): PeerClock {
        let clock = this.clocks.get(peer);
        if (!clock) {
            clock = new PeerClock();
            this.clocks.set(peer, clock);
        }
        return clock;
    }

    observeServerPacket(peer: string, remoteAt: number, localAt: number): void {
        this.serverPeer = peer;
        const clock = this.clock(peer);
        if (!clock.synchronized || !Number.isFinite(remoteAt)
            || !Number.isFinite(localAt)) return;
        // Duplicate/reordered packets must not inflate the jitter estimate.
        if (this.lastRemoteAt !== undefined && remoteAt <= this.lastRemoteAt) return;
        const jitter = this.lastRemoteAt === undefined ? 0 : Math.abs(
            (localAt - this.lastArrivalAt!) - (remoteAt - this.lastRemoteAt) / clock.rate);
        this.lastRemoteAt = remoteAt;
        this.lastArrivalAt = localAt;
        const age = Math.max(0, localAt - (remoteAt + clock.offset));
        this.arrivals.push({ at: localAt, age, jitter });
        this.arrivals = this.arrivals.filter(sample => localAt - sample.at <= 1000).slice(-120);
        this.jitterMs = percentile(this.arrivals.map(sample => sample.jitter), 0.9);
        const ageMs = percentile(this.arrivals.map(sample => sample.age), 0.9);
        // Stable links use one 30 Hz interval. Predict through ordinary transit
        // delay; add buffering only for jitter or latency beyond that safe bound.
        this.targetDelayMs = Math.min(MAX_PRESENTATION_DELAY_MS, Math.max(
            MIN_PRESENTATION_DELAY_MS,
            MIN_PRESENTATION_DELAY_MS + this.jitterMs,
            ageMs + MOVEMENT_SNAPSHOT_INTERVAL_MS - MAX_MOVEMENT_EXTRAPOLATION_MS,
        ));
    }

    clockAdjusted(peer: string, previousOffset: number, previousRate: number): void {
        const clock = this.clock(peer);
        if (peer !== this.serverPeer || (Math.abs(clock.offset - previousOffset) < 80
            && Math.abs(clock.rate - previousRate) < 0.08)) return;
        // Old packet ages were measured against a different clock model. They
        // must not pin the jitter buffer at its ceiling after synchronization.
        this.arrivals = [];
        this.lastRemoteAt = this.lastArrivalAt = undefined;
        this.delayMs = this.targetDelayMs = DEFAULT_PRESENTATION_DELAY_MS;
        this.jitterMs = 0;
    }

    advance(now: number): void {
        if (!Number.isFinite(now)) return;
        for (const clock of this.clocks.values()) clock.advance(now);
        const elapsed = this.lastNow === undefined ? 0 : Math.max(0, now - this.lastNow);
        this.lastNow = now;
        const rate = this.targetDelayMs > this.delayMs ? 0.5 : 0.1;
        const difference = this.targetDelayMs - this.delayMs;
        this.delayMs += Math.sign(difference) * Math.min(Math.abs(difference), elapsed * rate);
        const desired = now - this.delayMs;
        // Growing a jitter buffer slows presentation instead of running it
        // backwards. On resume, discard the old cursor rather than catch up for seconds.
        this.renderTime = this.renderTime === undefined || elapsed > 1000
            ? desired
            : Math.max(this.renderTime, Math.min(desired, this.renderTime + elapsed * 1.1));
        this.extrapolatedEntities = 0;
        this.sampledEntities = 0;
    }

    presentationDelay(now: number): number {
        return this.renderTime === undefined ? this.delayMs
            : Math.max(0, Math.min(MAX_PRESENTATION_DELAY_MS, now - this.renderTime));
    }

    resetPresentation(now: number): void {
        this.arrivals = [];
        this.lastRemoteAt = this.lastArrivalAt = undefined;
        this.delayMs = this.targetDelayMs = DEFAULT_PRESENTATION_DELAY_MS;
        this.lastNow = now;
        this.renderTime = now - this.delayMs;
        this.jitterMs = 0;
        this.generation++;
    }

    resetPeer(peer: string): void {
        this.clocks.delete(peer);
        if (peer !== this.serverPeer) return;
        this.arrivals = [];
        this.lastRemoteAt = this.lastArrivalAt = this.lastNow = undefined;
        this.renderTime = undefined;
        this.generation++;
        this.delayMs = this.targetDelayMs = DEFAULT_PRESENTATION_DELAY_MS;
        this.jitterMs = 0;
    }

    get stats() {
        const clock = this.clocks.get(this.serverPeer);
        return {
            synchronized: clock?.synchronized ?? false,
            rttMs: clock?.rttMs ?? 0,
            clockOffsetMs: clock?.offset ?? 0,
            sourceClockRate: clock?.rate ?? 1,
            jitterMs: this.jitterMs,
            bufferMs: this.lastNow === undefined ? this.delayMs : this.presentationDelay(this.lastNow),
            targetBufferMs: this.targetDelayMs,
            extrapolatedEntities: this.extrapolatedEntities,
            sampledEntities: this.sampledEntities,
        };
    }
}

export const NetworkTimingResource = new Resource<NetworkTiming>('NetworkTiming');

export interface MovementPlayback {
    clock: PeerClock;
    createdAt: number;
    cursor: number;
    deltaMs: number;
    delayMs: number;
}

export const MovementPlaybackComponent = new Component<MovementPlayback>('MovementPlayback');

export const AdvanceNetworkPlaybackSystem = new System({
    name: 'AdvanceNetworkPlayback',
    after: [NetworkReceivePhase, TimeSystem],
    args: [MovementPlaybackComponent, TimeResource, Optional(NetworkTimingResource)] as const,
    step(playback, time, network) {
        const renderTime = network?.renderTime ?? time.time - playback.delayMs;
        const cursor = Math.max(playback.cursor, renderTime - playback.clock.offset);
        playback.deltaMs = Math.min(100, cursor - playback.cursor);
        playback.cursor = cursor;
    },
});
