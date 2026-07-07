import { Entity } from '../entity.js';
import { World } from '../world.js';
import { restoreWorld, snapshotWorld, WorldSnapshot } from './snapshot_plugin.js';
import { TimeResource } from './time_plugin.js';

export interface RollbackOptions<Inputs> {
    /** How many past ticks of snapshots and inputs to keep. */
    capacity?: number;
    /**
     * Applies a tick's inputs to the world. Called immediately before
     * the world steps that tick, both during normal stepping and during
     * resimulation, so it must be deterministic given the same inputs.
     */
    applyInputs: (world: World, inputs: Inputs) => void;
    /** Completes restored entities (e.g. reattaches derived components). */
    complete?: (world: World, entity: Entity) => void;
}

/**
 * Drives a fixed-timestep world with a snapshot ring buffer and an
 * input history, supporting rollback: restore a past tick's state,
 * then resimulate to the present replaying the (possibly amended)
 * input history. This is the core of rollback netcode, but has no
 * networking itself: whoever owns the network (or a test harness)
 * decides what the inputs are and when to roll back.
 *
 * The tick counter is the world's TimeResource frame, which advances
 * exactly once per step on a fixed timestep.
 */
export class RollbackSimulation<Inputs> {
    private snapshots: { tick: number, snapshot: WorldSnapshot }[] = [];
    private inputs = new Map<number, Inputs>();
    private readonly capacity: number;

    constructor(private world: World,
        private options: RollbackOptions<Inputs>) {
        this.capacity = options.capacity ?? 64;
        // Baseline snapshot so rollbackTo(currentTick) always works.
        this.takeSnapshot();
    }

    get tick(): number {
        const time = this.world.resources.get(TimeResource);
        if (!time) {
            throw new Error('RollbackSimulation requires TimeResource');
        }
        return time.frame;
    }

    /** The oldest tick that can be rolled back to. */
    get earliestTick(): number {
        return this.snapshots[0]?.tick ?? this.tick;
    }

    /**
     * Records the inputs for a tick. For future ticks they apply when
     * that tick is stepped; amending a past tick's inputs takes effect
     * on the next rollback across it.
     */
    setInputs(tick: number, inputs: Inputs) {
        this.inputs.set(tick, inputs);
    }

    getInputs(tick: number): Inputs | undefined {
        return this.inputs.get(tick);
    }

    /** Advances one tick, applying that tick's recorded inputs. */
    step() {
        const inputs = this.inputs.get(this.tick + 1);
        if (inputs !== undefined) {
            this.options.applyInputs(this.world, inputs);
        }
        this.world.step();
        this.takeSnapshot();
    }

    /**
     * Restores the state at `tick` and resimulates to the present,
     * replaying the input history. Returns false if `tick` is older
     * than the snapshot buffer.
     */
    rollbackTo(tick: number): boolean {
        const target = this.tick;
        if (tick > target) {
            return false;
        }
        const entry = this.snapshots.find(s => s.tick === tick);
        if (!entry) {
            return false;
        }

        restoreWorld(this.world, entry.snapshot, this.options.complete);
        // Snapshots after the restore point belong to the abandoned
        // timeline; resimulation records fresh ones.
        this.snapshots = this.snapshots.filter(s => s.tick <= tick);

        while (this.tick < target) {
            this.step();
        }
        return true;
    }

    private takeSnapshot() {
        this.snapshots.push({ tick: this.tick, snapshot: snapshotWorld(this.world) });
        while (this.snapshots.length > this.capacity) {
            this.snapshots.shift();
        }
        // Inputs older than the oldest snapshot can never be replayed.
        const earliest = this.earliestTick;
        for (const tick of this.inputs.keys()) {
            if (tick <= earliest) {
                this.inputs.delete(tick);
            }
        }
    }
}
