import {
    GovernmentData,
    GovernmentFlags,
    canHailGovernment,
    canTargetPlayer,
    relation,
} from "./govt_relations";
import {
    clearProvocation,
    createProvocationState,
    isProvoked,
    pruneProvocations,
    recordProvocation,
} from "./npc_hostility";

function makeGovernment(
    id: number,
    classes: number[],
    allies: number[] = [],
    enemies: number[] = [],
    flags = 0,
): GovernmentData {
    return {
        id: `nova:${id}`,
        name: `Government ${id}`,
        prefix: "nova",
        classes,
        allies,
        enemies,
        flags,
    };
}

describe("government relations", () => {
    it("uses class lists without treating shared classes as alliances", () => {
        const federation = makeGovernment(128, [1], [2], [3]);
        const independent = makeGovernment(129, [1]);
        const ally = makeGovernment(130, [2]);
        const pirate = makeGovernment(131, [3]);

        expect(relation(federation, independent)).toBe("neutral");
        expect(relation(federation, ally)).toBe("ally");
        expect(relation(federation, pirate)).toBe("enemy");
    });

    it("treats xenophobic governments as hostile to non-allies", () => {
        const xenophobe = makeGovernment(
            128,
            [1],
            [2],
            [],
            GovernmentFlags.xenophobic,
        );

        expect(relation(xenophobe, makeGovernment(129, [3]))).toBe("enemy");
        expect(relation(xenophobe, makeGovernment(130, [2]))).toBe("ally");
        expect(relation(xenophobe, makeGovernment(128, [1]))).toBe("ally");
    });

    it("applies player targeting flags before session provocation", () => {
        const ordinary = makeGovernment(128, [1]);
        const always = makeGovernment(
            129, [1], [], [], GovernmentFlags.alwaysAttacksPlayer);
        const never = makeGovernment(
            130, [1], [], [],
            GovernmentFlags.alwaysAttacksPlayer
            | GovernmentFlags.neverAttacksPlayer,
        );

        expect(canTargetPlayer(ordinary)).toBe(false);
        expect(canTargetPlayer(ordinary, true)).toBe(true);
        expect(canTargetPlayer(always)).toBe(true);
        expect(canTargetPlayer(never, true)).toBe(false);
    });

    it("exposes the Bible's hail flag independently of targeting", () => {
        const talkative = makeGovernment(128, [1]);
        const silent = makeGovernment(
            129, [1], [], [], GovernmentFlags.cannotHail);

        expect(canHailGovernment(talkative)).toBe(true);
        expect(canHailGovernment(silent)).toBe(false);
    });
});

describe("NPC provocation state", () => {
    it("propagates hostility through allied governments", () => {
        const state = createProvocationState();
        recordProvocation(state, 128, "attacker");

        expect(isProvoked(state, 128, "attacker", () => "neutral")).toBe(true);
        expect(isProvoked(state, 129, "attacker", () => "neutral")).toBe(false);
        expect(isProvoked(state, 129, "attacker", () => "ally")).toBe(true);
    });

    it("clears attackers when they leave the session or are removed", () => {
        const state = createProvocationState();
        recordProvocation(state, 128, "attacker");
        recordProvocation(state, 129, "other");

        pruneProvocations(state, new Set(["other"]));
        expect(isProvoked(state, 128, "attacker", () => "ally")).toBe(false);
        expect(isProvoked(state, 129, "other", () => "neutral")).toBe(true);

        clearProvocation(state, "other");
        expect(state.attackersByVictimGovernment.size).toBe(0);
    });
});
