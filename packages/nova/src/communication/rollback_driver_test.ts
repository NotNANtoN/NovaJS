import "jasmine";
import { Random } from "nova_ecs/plugins/random_plugin";
import { RollbackSimulation } from "nova_ecs/plugins/rollback_plugin";
import { hashWorld } from "nova_ecs/plugins/world_hash";
import { World } from "nova_ecs/world";
import { ControlEvent, EcsControlEvent } from "../nova_plugin/controls_plugin.js";
import { deriveEntityComponents } from "../nova_plugin/entity_factory.js";
import { makeDeterminismWorld } from "./determinism_harness.js";

type Inputs = ControlEvent[];

function applyInputs(world: World, inputs: Inputs) {
    world.emit(EcsControlEvent, inputs);
}

/**
 * A deterministic pseudo-random input schedule: occasionally presses
 * or releases a control. Edge-triggered, like real keyboard input.
 */
function makeInputSchedule(seed: number, ticks: number): Map<number, Inputs> {
    const rng = new Random(seed);
    const actions = ['accelerate', 'turnLeft', 'turnRight', 'firePrimary'] as const;
    const held = new Map<string, boolean>();
    const schedule = new Map<number, Inputs>();
    for (let tick = 1; tick <= ticks; tick++) {
        if (rng.next() < 0.15) {
            const action = actions[rng.below(actions.length)]!;
            const start = !held.get(action);
            held.set(action, start);
            schedule.set(tick, [{ action, state: start ? 'start' : false }]);
        }
    }
    return schedule;
}

/** Straight-line run: the ground truth the rollback runs must match. */
async function referenceRun(npcCount: number, schedule: Map<number, Inputs>,
    ticks: number): Promise<string> {
    const world = await makeDeterminismWorld(npcCount);
    for (let tick = 1; tick <= ticks; tick++) {
        const inputs = schedule.get(tick);
        if (inputs) {
            applyInputs(world, inputs);
        }
        world.step();
    }
    return hashWorld(world).hash;
}

function makeRollback(world: World) {
    return new RollbackSimulation<Inputs>(world, {
        applyInputs,
        complete: deriveEntityComponents,
    });
}

describe("RollbackSimulation", () => {
    // Rolling back and resimulating with unchanged inputs must be a
    // semantic no-op, no matter when or how deep the rollbacks are.
    it("converges to the reference run under random rollbacks", async () => {
        const TICKS = 150;
        const schedule = makeInputSchedule(12345, TICKS);
        const reference = await referenceRun(2, schedule, TICKS);

        const world = await makeDeterminismWorld(2);
        const rollback = makeRollback(world);
        const chaos = new Random(999);
        for (let tick = 1; tick <= TICKS; tick++) {
            const inputs = schedule.get(tick);
            if (inputs) {
                rollback.setInputs(tick, inputs);
            }
            rollback.step();
            if (chaos.next() < 0.1) {
                const depth = 1 + chaos.below(20);
                const target = Math.max(rollback.earliestTick, rollback.tick - depth);
                expect(rollback.rollbackTo(target)).toBeTrue();
                expect(rollback.tick).toBe(tick);
            }
        }
        expect(hashWorld(world).hash).toEqual(reference);
    }, 120_000);

    // The netcode scenario: inputs arrive d ticks late; the sim
    // predicts no-new-input, then rolls back and corrects when the
    // real inputs arrive. Must converge to the undelayed run.
    it("converges when inputs arrive late and are corrected by rollback", async () => {
        const TICKS = 120;
        const DELAY = 8;
        const schedule = makeInputSchedule(777, TICKS);
        const reference = await referenceRun(2, schedule, TICKS);

        const world = await makeDeterminismWorld(2);
        const rollback = makeRollback(world);
        for (let tick = 1; tick <= TICKS; tick++) {
            // The inputs for tick - DELAY arrive now. Prediction was
            // "no new inputs", so any real inputs are a misprediction.
            const arrived = tick - DELAY;
            const inputs = schedule.get(arrived);
            if (arrived >= 1 && inputs) {
                rollback.setInputs(arrived, inputs);
                expect(rollback.rollbackTo(arrived - 1)).toBeTrue();
            }
            rollback.step();
        }
        // Deliver the tail still in flight, then one final rollback.
        let earliestCorrection: number | undefined;
        for (let tick = TICKS - DELAY + 1; tick <= TICKS; tick++) {
            const inputs = schedule.get(tick);
            if (inputs) {
                rollback.setInputs(tick, inputs);
                earliestCorrection = earliestCorrection ?? tick;
            }
        }
        if (earliestCorrection !== undefined) {
            expect(rollback.rollbackTo(earliestCorrection - 1)).toBeTrue();
        }

        expect(rollback.tick).toBe(TICKS);
        expect(hashWorld(world).hash).toEqual(reference);
    }, 120_000);

    it("refuses to roll back past the snapshot buffer", async () => {
        const world = await makeDeterminismWorld(0);
        const rollback = new RollbackSimulation<Inputs>(world, {
            applyInputs,
            complete: deriveEntityComponents,
            capacity: 10,
        });
        for (let i = 0; i < 30; i++) {
            rollback.step();
        }
        expect(rollback.rollbackTo(rollback.earliestTick - 1)).toBeFalse();
        expect(rollback.rollbackTo(rollback.earliestTick)).toBeTrue();
    }, 60_000);
});
