import "jasmine";
import {
    firstHostileEdge, initialJumpReadyState, JumpReadyInputs, jumpReadyEdge,
    risingEdge, targetChangedEdge,
} from "./ui_sound_logic.js";

describe("targetChangedEdge", () => {
    it("beeps when selecting a target from none", () => {
        expect(targetChangedEdge(undefined, "ship-1"))
            .toEqual({ beep: true, next: "ship-1" });
    });
    it("beeps when retargeting to a different target", () => {
        expect(targetChangedEdge("ship-1", "ship-2"))
            .toEqual({ beep: true, next: "ship-2" });
    });
    it("does not beep when the target is unchanged", () => {
        expect(targetChangedEdge("ship-1", "ship-1"))
            .toEqual({ beep: false, next: "ship-1" });
    });
    it("does not beep when clearing the target", () => {
        expect(targetChangedEdge("ship-1", undefined))
            .toEqual({ beep: false, next: undefined });
    });
});

describe("risingEdge", () => {
    it("beeps only on the false -> true transition", () => {
        expect(risingEdge(false, true)).toEqual({ beep: true, next: true });
    });
    it("does not beep while it stays true", () => {
        expect(risingEdge(true, true)).toEqual({ beep: false, next: true });
    });
    it("does not beep on true -> false and re-arms", () => {
        expect(risingEdge(true, false)).toEqual({ beep: false, next: false });
        // Re-armed: next false -> true beeps again.
        expect(risingEdge(false, true)).toEqual({ beep: true, next: true });
    });
});

describe("firstHostileEdge", () => {
    it("beeps on empty -> non-empty", () => {
        expect(firstHostileEdge(false, true)).toEqual({ beep: true, next: true });
    });
    it("stays silent while some ship remains hostile", () => {
        expect(firstHostileEdge(true, true)).toEqual({ beep: false, next: true });
    });
    it("re-arms when the hostile set empties, then beeps on the next flip", () => {
        const cleared = firstHostileEdge(true, false);
        expect(cleared).toEqual({ beep: false, next: false });
        expect(firstHostileEdge(cleared.next, true))
            .toEqual({ beep: true, next: true });
    });
});

describe("jumpReadyEdge", () => {
    const eligible: JumpReadyInputs = {
        hasRoute: true, distance: 1200, jumpRadius: 1000,
        fuel: 100, fuelPerJump: 100, routeHead: "sys-2",
    };

    it("beeps the moment eligibility flips true", () => {
        const r = jumpReadyEdge(initialJumpReadyState(), eligible);
        expect(r.beep).toBeTrue();
        expect(r.next).toEqual({ eligible: true, routeHead: "sys-2" });
    });

    it("does not beep while eligibility stays true for the same route", () => {
        const first = jumpReadyEdge(initialJumpReadyState(), eligible);
        expect(jumpReadyEdge(first.next, eligible).beep).toBeFalse();
    });

    it("does not become eligible inside the no-jump zone", () => {
        const inside = { ...eligible, distance: 800 };
        expect(jumpReadyEdge(initialJumpReadyState(), inside))
            .toEqual({ beep: false, next: { eligible: false, routeHead: "sys-2" } });
    });

    it("does not become eligible without a route", () => {
        const noRoute = { ...eligible, hasRoute: false, routeHead: undefined };
        expect(jumpReadyEdge(initialJumpReadyState(), noRoute).beep).toBeFalse();
    });

    it("does not become eligible without enough fuel", () => {
        const noFuel = { ...eligible, fuel: 50 };
        expect(jumpReadyEdge(initialJumpReadyState(), noFuel).beep).toBeFalse();
    });

    it("honors an outfit-widened no-jump radius", () => {
        // jumpRadius raised above the ship's distance: not yet eligible.
        const widened = { ...eligible, jumpRadius: 1500 };
        expect(jumpReadyEdge(initialJumpReadyState(), widened).beep).toBeFalse();
    });

    it("re-arms and beeps again when the route's next hop changes", () => {
        const first = jumpReadyEdge(initialJumpReadyState(), eligible);
        expect(first.beep).toBeTrue();
        // Still eligible but a new destination was picked: beep again.
        const rerouted = { ...eligible, routeHead: "sys-3" };
        const second = jumpReadyEdge(first.next, rerouted);
        expect(second.beep).toBeTrue();
        expect(second.next.routeHead).toBe("sys-3");
    });

    it("re-arms after eligibility drops (e.g. after jumping) then beeps", () => {
        const first = jumpReadyEdge(initialJumpReadyState(), eligible);
        // Drift inside the zone: eligibility drops, no beep.
        const dropped = jumpReadyEdge(first.next, { ...eligible, distance: 500 });
        expect(dropped.beep).toBeFalse();
        // Back outside: beeps again.
        expect(jumpReadyEdge(dropped.next, eligible).beep).toBeTrue();
    });
});
