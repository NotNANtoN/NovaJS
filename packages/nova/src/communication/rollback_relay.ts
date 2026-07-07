import { Communicator } from "nova_ecs/plugins/multiplayer_plugin";
import { Subscription } from "rxjs";
import { SIMULATION_STEP_MS } from "../nova_plugin/make_system.js";
import { ArchiveBaseline, canonicalDesyncHash, InputRecord, RollbackProtocolMessage, unwrapRollbackMessage, wrapRollbackMessage } from "./rollback_protocol.js";

/**
 * The server's role in rollback multiplayer: not a simulation
 * authority, but the room's input relay, tick clock, and input
 * archive.
 *
 * - Relay: forwards each peer's tick-stamped input records to the
 *   other peers, stamping the sender's identity and clamping the tick
 *   so nobody can inject inputs into the past.
 * - Clock: advances the canonical tick at the fixed simulation rate
 *   and broadcasts it periodically so peers can pace themselves.
 * - Archive: retains the input log and serves it to late joiners.
 */
/**
 * How long (in ticks) an incomplete set of state-hash reports waits
 * for stragglers before being compared as-is and dropped.
 */
const STATE_HASH_SWEEP_TICKS = 600;

/**
 * A peer is convicted of desync only after this many *consecutive*
 * mismatched checkpoints. A rollback correction that lands deeper
 * than the settle margin makes every peer's already-sent report
 * describe the abandoned timeline — a false positive that corrects
 * itself by the next checkpoint. Real divergence persists.
 */
const DEFAULT_DESYNC_THRESHOLD = 3;

/**
 * A checkpoint report arriving more than this many ticks after its
 * checkpoint comes from a client running well behind the room's
 * clock (a throttled tab, an overloaded machine). Such reports are
 * still compared — a stale client can be convicted — but they get no
 * vote in what the canonical state is.
 */
const TIMELY_REPORT_TICKS = 240;

export class RollbackRelay {
    tick = 0;
    private log: InputRecord[] = [];
    /** Peers' state-hash reports awaiting comparison, by tick. */
    private stateHashes =
        new Map<number, Map<string, { hash: string, arrivedAt: number }>>();
    private getBaseline?: () => ArchiveBaseline | undefined;
    private getReferenceHash?: (tick: number) => string | undefined;
    private readonly desyncThreshold: number;
    private onArchiveOutvoted?: (tick: number) => void;
    /** Consecutive mismatched checkpoints per reporter. */
    private mismatchStreaks = new Map<string, number>();
    private readonly subscription: Subscription;
    private clockInterval?: ReturnType<typeof setInterval>;
    private syncInterval?: ReturnType<typeof setInterval>;
    private lastClockTime?: number;
    private clockDebt = 0;

    private leaveSubscription: Subscription;

    constructor(private room: Communicator,
        { autoClock = true, stepMs = SIMULATION_STEP_MS, baseline,
            referenceHash, onArchiveOutvoted,
            desyncThreshold = DEFAULT_DESYNC_THRESHOLD }: {
                autoClock?: boolean, stepMs?: number,
                /** The newest archived baseline, when an archive runs. */
                baseline?: () => ArchiveBaseline | undefined,
                /** The archive sim's hash at a checkpoint tick: the
                 * true simulation's vote in desync comparisons. */
                referenceHash?: (tick: number) => string | undefined,
                /** Consecutive mismatched checkpoints before a desync
                 * broadcast (1 = convict immediately). */
                desyncThreshold?: number,
                /** Called when unanimous peers outvote the archive:
                 * the hook for dumping archive-side diagnostics. */
                onArchiveOutvoted?: (tick: number) => void,
            } = {}) {
        this.getBaseline = baseline;
        this.getReferenceHash = referenceHash;
        this.desyncThreshold = desyncThreshold;
        this.onArchiveOutvoted = onArchiveOutvoted;
        this.subscription = room.messages.subscribe(({ source, message }) => {
            this.handleMessage(source, message);
        });
        // A disconnect is an input: the server authors a removePeer
        // record so every peer (and the log) deterministically removes
        // the ship.
        this.leaveSubscription = room.peers.leave.subscribe(peerId => {
            const record: InputRecord = {
                peerId: this.room.uuid,
                tick: this.tick + 1,
                inputs: [{ kind: 'removePeer', peerId }],
            };
            this.log.push(record);
            this.room.sendMessage(
                wrapRollbackMessage({ kind: 'inputs', record }));
        });

        if (autoClock) {
            this.lastClockTime = performance.now();
            this.clockInterval = setInterval(() => {
                const now = performance.now();
                this.clockDebt = Math.min(
                    this.clockDebt + (now - this.lastClockTime!), stepMs * 600);
                this.lastClockTime = now;
                const ticks = Math.floor(this.clockDebt / stepMs);
                this.clockDebt -= ticks * stepMs;
                this.advanceTicks(ticks);
            }, stepMs);
            this.syncInterval = setInterval(() => {
                this.room.sendMessage(
                    wrapRollbackMessage({ kind: 'tickSync', tick: this.tick }));
                // Hash reports that will never complete (a peer left or
                // joined mid-window) still get compared, then dropped.
                for (const tick of [...this.stateHashes.keys()]) {
                    if (tick < this.tick - STATE_HASH_SWEEP_TICKS) {
                        this.compareStateHashes(tick, true);
                    }
                }
            }, 1000);
        }
    }

    advanceTicks(ticks: number) {
        this.tick += ticks;
    }

    get inputLog(): readonly InputRecord[] {
        return this.log;
    }

    /**
     * Drops records at or before `uptoTick` — safe once an archived
     * baseline at that tick exists, since reconstruction starts there.
     * Bounds the log's memory for long-lived rooms.
     */
    trimLog(uptoTick: number) {
        this.log = this.log.filter(record => record.tick > uptoTick);
    }

    /** The room's peers, excluding the relay itself. */
    private roomPeers(): Set<string> {
        const peers = new Set(this.room.peers.current.value);
        if (this.room.uuid) {
            peers.delete(this.room.uuid);
        }
        return peers;
    }

    private otherPeers(exclude: string): Set<string> {
        const peers = this.roomPeers();
        peers.delete(exclude);
        return peers;
    }

    /**
     * Compares a tick's state-hash reports once every current peer has
     * reported (or immediately, when forced by the stale sweep). On
     * mismatch, broadcasts a desync notification; the diverged peers
     * recover by resimulating the input log.
     */
    private compareStateHashes(tick: number, force = false) {
        const reports = this.stateHashes.get(tick);
        if (!reports) {
            return;
        }
        if (!force) {
            for (const peer of this.roomPeers()) {
                if (!reports.has(peer)) {
                    return;
                }
            }
        }
        this.stateHashes.delete(tick);
        const reference = this.getReferenceHash?.(tick);

        // Only timely reports vote on the canonical state: a report
        // this far behind the room's clock comes from a throttled or
        // overloaded client, whose word shouldn't decide who resyncs.
        // (Stale reporters are still compared, and convicted, below.)
        // The archive's hash always joins as a standing witness: it
        // breaks two-peer ties (a tie-break alone can crown the
        // diverged peer canonical, making the divergence permanent),
        // and it convicts a lone diverged peer whose roommates report
        // nothing at all.
        const voters: [string, string][] = [...reports]
            .filter(([, report]) => report.arrivedAt - tick <= TIMELY_REPORT_TICKS)
            .map(([peerId, report]) => [peerId, report.hash]);
        const allHashes: [string, string][] = [...reports]
            .map(([peerId, report]) => [peerId, report.hash]);
        if (reference !== undefined && this.room.uuid) {
            voters.push([this.room.uuid, reference]);
            allHashes.push([this.room.uuid, reference]);
        }
        if (new Set(allHashes.map(([, hash]) => hash)).size <= 1) {
            for (const [peerId] of allHashes) {
                this.mismatchStreaks.delete(peerId);
            }
            return;
        }
        const canonical = canonicalDesyncHash(voters,
            this.room.uuid ? new Set([this.room.uuid]) : undefined);
        if (canonical === undefined) {
            // Nothing but stale reports and no archive: no one to
            // trust, so no verdict.
            return;
        }
        // Convict only after `desyncThreshold` consecutive mismatched
        // checkpoints: a rollback correction landing deeper than the
        // settle margin makes already-sent reports describe the
        // abandoned timeline — a false positive gone by the next
        // checkpoint. Real divergence keeps the streak alive.
        let convict = false;
        for (const [peerId, hash] of allHashes) {
            if (hash === canonical) {
                this.mismatchStreaks.delete(peerId);
                continue;
            }
            const streak = (this.mismatchStreaks.get(peerId) ?? 0) + 1;
            this.mismatchStreaks.set(peerId, streak);
            if (streak >= this.desyncThreshold) {
                convict = true;
                this.mismatchStreaks.delete(peerId);
            }
        }
        if (!convict) {
            return;
        }
        console.log(`Desync at tick ${tick} (canonical ${canonical}):`,
            Object.fromEntries(allHashes));
        // The timely majority outvoting the archive means the
        // *archive* has diverged — and every baseline it captures from
        // here on reconstructs the wrong world. Loud, because recovery
        // (rebuilding the archive) is not automatic yet.
        if (reference !== undefined && canonical !== reference) {
            console.error(
                `Archive diverged from all peers at tick ${tick}`);
            this.onArchiveOutvoted?.(tick);
        }
        this.room.sendMessage(wrapRollbackMessage({
            kind: 'desync', tick, hashes: allHashes, canonical,
        }));
    }

    private handleMessage(source: string, raw: unknown) {
        const message = unwrapRollbackMessage(raw);
        if (!message) {
            return;
        }
        switch (message.kind) {
            case 'inputs': {
                // Stamp identity and clamp time: peers cannot speak for
                // others or inject inputs into the past.
                const record: InputRecord = {
                    peerId: source,
                    tick: Math.max(message.record.tick, this.tick + 1),
                    inputs: message.record.inputs,
                };
                this.log.push(record);
                const others = this.otherPeers(source);
                if (others.size > 0) {
                    this.room.sendMessage(
                        wrapRollbackMessage({ kind: 'inputs', record }), others);
                }
                break;
            }
            case 'joinRequest': {
                // With an archived baseline, reconstruction starts
                // there: only the log tail after it is needed.
                const baseline = this.getBaseline?.();
                this.room.sendMessage(wrapRollbackMessage({
                    kind: 'catchUp',
                    tick: this.tick,
                    records: baseline
                        ? this.log.filter(record => record.tick > baseline.tick)
                        : [...this.log],
                    ...(baseline ? { baseline } : {}),
                }), source);
                break;
            }
            case 'stateHash': {
                let reports = this.stateHashes.get(message.tick);
                if (!reports) {
                    reports = new Map();
                    this.stateHashes.set(message.tick, reports);
                }
                reports.set(source,
                    { hash: message.hash, arrivedAt: this.tick });
                this.compareStateHashes(message.tick);
                break;
            }
            case 'inputLogRequest': {
                this.room.sendMessage(wrapRollbackMessage({
                    kind: 'inputLog',
                    records: this.log.filter(record => record.tick >= message.fromTick),
                }), source);
                break;
            }
            // 'tickSync' and 'inputLog' are server -> peer only.
        }
    }

    close() {
        this.subscription.unsubscribe();
        this.leaveSubscription.unsubscribe();
        if (this.clockInterval !== undefined) {
            clearInterval(this.clockInterval);
        }
        if (this.syncInterval !== undefined) {
            clearInterval(this.syncInterval);
        }
    }
}
