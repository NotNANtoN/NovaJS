import "jasmine";
import { runDeterminismCheck } from "./determinism_harness.js";

describe("Simulation determinism", () => {
    // The acceptance gate for the fixed timestep: a quiet world (no
    // weapons fire, no NPC AI randomness) must produce identical state
    // hash streams across two runs. Combat determinism additionally needs
    // seeded RNG and deterministic entity ids (rollback plan, Phase 1).
    it("is deterministic for a quiet world", async () => {
        const messages: string[] = [];
        const result = await runDeterminismCheck(0, 240, 240,
            message => messages.push(message));
        expect(result.divergedAtStep)
            .withContext(messages.join('\n'))
            .toBeUndefined();
        expect(result.stepsRun).toBe(240);
    }, 60_000);
});
