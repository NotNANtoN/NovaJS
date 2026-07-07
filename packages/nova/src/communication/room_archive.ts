import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { wireSnapshotWorld } from "nova_ecs/plugins/snapshot_plugin";
import { World } from "nova_ecs/world";
import { ArchiveBaseline } from "./rollback_protocol.js";
import { RollbackRelay } from "./rollback_relay.js";
import { applyInputRecords, InputRecord, loadInputRecordsGameData } from "./simulation_input.js";

/** How often the archive captures a baseline: 30 seconds at 60Hz. */
const ARCHIVE_INTERVAL_TICKS = 1800;
/** How often the archive sim catches up to the relay clock. */
const UPDATE_INTERVAL_MS = 1000;

/**
 * The server's periodic snapshot archive for one room: a trailing
 * simulation of the room's deterministic world, wire-snapshotted every
 * interval so joiners (and desync resyncs) reconstruct from a recent
 * baseline instead of replaying the whole log from genesis — which
 * also lets the relay trim the log behind the newest baseline,
 * bounding both costs for long-lived rooms.
 *
 * The archive never rolls back: it steps only to the relay's current
 * tick, and the relay clamps every arriving record to a future tick,
 * so the inputs at or before the relay clock are final. Trailing the
 * clock (rather than pacing ahead like a player) costs nothing — the
 * archive has no inputs of its own.
 */
export class RoomArchive {
    /** The newest baseline; wire it to the relay's `baseline` option. */
    latest?: ArchiveBaseline;
    private world?: World;
    private lastBaselineTick = 0;
    private updating = false;
    private updateInterval?: ReturnType<typeof setInterval>;

    constructor(
        private relay: RollbackRelay,
        private makeWorld: () => Promise<World>,
        { intervalTicks = ARCHIVE_INTERVAL_TICKS, autoUpdate = true, name }: {
            intervalTicks?: number,
            autoUpdate?: boolean,
            /** Label for log lines (e.g. the room's system id). */
            name?: string,
        } = {}) {
        this.intervalTicks = intervalTicks;
        this.name = name;
        if (autoUpdate) {
            this.updateInterval = setInterval(() => {
                void this.update();
            }, UPDATE_INTERVAL_MS);
        }
    }
    private readonly intervalTicks: number;
    private readonly name?: string;

    get tick(): number {
        return this.world?.resources.get(TimeResource)?.frame ?? 0;
    }

    /**
     * Steps the archive sim up to the relay's current tick, applying
     * the logged inputs, and captures a baseline when the interval has
     * elapsed. Reentrancy-guarded: updates skip while one is running.
     */
    async update(): Promise<void> {
        if (this.updating) {
            return;
        }
        this.updating = true;
        try {
            if (!this.world) {
                this.world = await this.makeWorld();
            }
            const world = this.world;
            const target = this.relay.tick;
            if (this.tick < target) {
                const pending = this.relay.inputLog.filter(
                    record => record.tick > this.tick && record.tick <= target);
                // Insertions replayed here were staged by their
                // originating peer, not by this world: stage them now
                // so applying them is synchronous.
                await loadInputRecordsGameData(world, pending);
                const byTick = new Map<number, InputRecord[]>();
                for (const record of pending) {
                    byTick.set(record.tick,
                        [...byTick.get(record.tick) ?? [], record]);
                }
                while (this.tick < target) {
                    const records = byTick.get(this.tick + 1);
                    if (records) {
                        applyInputRecords(world, records);
                    }
                    world.step();
                }
            }
            if (this.tick - this.lastBaselineTick >= this.intervalTicks) {
                this.latest = {
                    tick: this.tick,
                    snapshot: wireSnapshotWorld(world),
                };
                this.lastBaselineTick = this.tick;
                // Reconstruction starts at the baseline now; the log
                // before it can never be needed again.
                this.relay.trimLog(this.tick);
                console.log(`Archived ${this.name ?? 'room'} at tick ${this.tick}`);
            }
        } finally {
            this.updating = false;
        }
    }

    close() {
        if (this.updateInterval !== undefined) {
            clearInterval(this.updateInterval);
        }
    }
}
