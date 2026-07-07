import { Communicator } from "nova_ecs/plugins/multiplayer_plugin";
import { Subscription } from "rxjs";
import { SIMULATION_STEP_MS } from "../nova_plugin/make_system.js";
import { ArchiveBaseline, InputRecord, RollbackProtocolMessage, unwrapRollbackMessage, wrapRollbackMessage } from "./rollback_protocol.js";

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

export class RollbackRelay {
    tick = 0;
    private log: InputRecord[] = [];
    /** Peers' state-hash reports awaiting comparison, by tick. */
    private stateHashes = new Map<number, Map<string, string>>();
    private getBaseline?: () => ArchiveBaseline | undefined;
    private getReferenceHash?: (tick: number) => string | undefined;
    private readonly subscription: Subscription;
    private clockInterval?: ReturnType<typeof setInterval>;
    private syncInterval?: ReturnType<typeof setInterval>;
    private lastClockTime?: number;
    private clockDebt = 0;

    private leaveSubscription: Subscription;

    constructor(private room: Communicator,
        { autoClock = true, stepMs = SIMULATION_STEP_MS, baseline,
            referenceHash }: {
                autoClock?: boolean, stepMs?: number,
                /** The newest archived baseline, when an archive runs. */
                baseline?: () => ArchiveBaseline | undefined,
                /** The archive sim's hash at a checkpoint tick: the
                 * true simulation's vote in desync comparisons. */
                referenceHash?: (tick: number) => string | undefined,
            } = {}) {
        this.getBaseline = baseline;
        this.getReferenceHash = referenceHash;
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
        // The archive's hash joins every comparison as a standing
        // witness: it breaks two-peer ties (a tie-break alone can
        // crown the diverged peer canonical, making the divergence
        // permanent), and it convicts a lone diverged peer whose
        // roommates are throttled and reporting nothing.
        const reference = this.getReferenceHash?.(tick);
        if (reference !== undefined && this.room.uuid) {
            reports.set(this.room.uuid, reference);
        }
        if (new Set(reports.values()).size > 1) {
            console.log(`Desync at tick ${tick}:`,
                Object.fromEntries(reports));
            // Unanimous peers against the archive means the *archive*
            // has diverged — and every baseline it captures from here
            // on reconstructs the wrong world. Loud, because recovery
            // (rebuilding the archive) is not automatic yet.
            const peerHashes = new Set([...reports]
                .filter(([peerId]) => peerId !== this.room.uuid)
                .map(([, hash]) => hash));
            if (reference !== undefined && peerHashes.size === 1
                && !peerHashes.has(reference)) {
                console.error(
                    `Archive diverged from all peers at tick ${tick}`);
            }
            this.room.sendMessage(wrapRollbackMessage({
                kind: 'desync', tick, hashes: [...reports],
            }));
        }
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
                reports.set(source, message.hash);
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
