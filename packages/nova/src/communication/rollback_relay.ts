import { Communicator } from "nova_ecs/plugins/multiplayer_plugin";
import { Subscription } from "rxjs";
import { SIMULATION_STEP_MS } from "../nova_plugin/make_system.js";
import { InputRecord, RollbackProtocolMessage, unwrapRollbackMessage, wrapRollbackMessage } from "./rollback_protocol.js";

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
export class RollbackRelay {
    tick = 0;
    private log: InputRecord[] = [];
    private readonly subscription: Subscription;
    private clockInterval?: ReturnType<typeof setInterval>;
    private syncInterval?: ReturnType<typeof setInterval>;
    private lastClockTime?: number;
    private clockDebt = 0;

    private leaveSubscription: Subscription;

    constructor(private room: Communicator,
        { autoClock = true, stepMs = SIMULATION_STEP_MS }:
            { autoClock?: boolean, stepMs?: number } = {}) {
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
            }, 1000);
        }
    }

    advanceTicks(ticks: number) {
        this.tick += ticks;
    }

    get inputLog(): readonly InputRecord[] {
        return this.log;
    }

    private otherPeers(exclude: string): Set<string> {
        const peers = new Set(this.room.peers.current.value);
        peers.delete(exclude);
        if (this.room.uuid) {
            peers.delete(this.room.uuid);
        }
        return peers;
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
                this.room.sendMessage(wrapRollbackMessage({
                    kind: 'catchUp',
                    tick: this.tick,
                    records: [...this.log],
                }), source);
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
