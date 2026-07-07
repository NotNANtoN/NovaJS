import "jasmine";
import { runDeterminismCheck } from "./determinism_harness.js";

describe("Simulation determinism", () => {
    // Entities are staged (fully loaded before insertion) and the sim
    // never resolves data asynchronously mid-step, so two identical
    // worlds must produce identical state hash streams from tick 0.
    it("is deterministic for a quiet world", async () => {
        const messages: string[] = [];
        const result = await runDeterminismCheck(0, 240, 0,
            message => messages.push(message));
        expect(result.divergedAtStep)
            .withContext(messages.join('\n'))
            .toBeUndefined();
        expect(result.stepsRun).toBe(240);
    }, 60_000);

    // Exercises seeded weapon spread, submunition cones, NPC targeting,
    // damage, and deterministic entity ids for spawned projectiles.
    it("is deterministic with NPCs fighting", async () => {
        const messages: string[] = [];
        const result = await runDeterminismCheck(4, 240, 0,
            message => messages.push(message));
        expect(result.divergedAtStep)
            .withContext(messages.join('\n'))
            .toBeUndefined();
        expect(result.stepsRun).toBe(240);
    }, 120_000);
});
