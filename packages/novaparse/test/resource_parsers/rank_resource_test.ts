import "jasmine";
import { RankResource } from "../../src/resource_parsers/rank_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A ränk resource with every field set to a distinct, recognizable value. */
function buildRank(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(500)                            // weight
        .int16(200)                         // affilGovt
        .int16(90)                          // priceMod
        .int32(1000)                        // salary
        .int32(2000000)                     // salaryCap
        .uint64(0x0000000100000002n)        // contribute
        .uint16(0x0209)                     // flags
        .string("Space Marshall", 64)       // convName
        .string("Marshall", 64);            // convShortName
    return b;
}

describe("RankResource", () => {
    // Rank resources don't depend on other resources for parsing.
    const idSpace = defaultIDSpace;

    let rank: RankResource;

    beforeEach(() => {
        rank = new RankResource(
            buildRank().resource("ränk", 128, "Space Marshall of Foo"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 152 bytes is the size of every ränk in Nova's own data files.
        expect(buildRank().byteLength).toBe(152);
    });

    it("parses numeric fields", () => {
        expect(rank.weight).toBe(500);
        expect(rank.affilGovt).toBe(200);
        expect(rank.priceMod).toBe(90);
        expect(rank.salary).toBe(1000);
        expect(rank.salaryCap).toBe(2000000);
    });

    it("parses contribute", () => {
        expect(rank.contribute).toBe(0x0000000100000002n);
    });

    it("parses flags", () => {
        expect(rank.flags).toBe(0x0209);
        expect(rank.dropOtherRanksWhenActivated).toBe(true);
        expect(rank.dropOtherRanksWhenDeactivated).toBe(false);
        expect(rank.permanent).toBe(true);
        expect(rank.canAlwaysLandOnGovtStellars).toBe(true);
        expect(rank.govtShipsWontAttack).toBe(false);
        expect(rank.freeRefuelAndRepair).toBe(false);
    });

    it("parses names", () => {
        expect(rank.convName).toBe("Space Marshall");
        expect(rank.convShortName).toBe("Marshall");
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off immediately after flags (offset 24).
        const truncated = buildRank().truncate(24);
        const rank = new RankResource(
            truncated.resource("ränk", 129, "Truncated"), idSpace);
        expect(rank.flags).toBe(0x0209);
        expect(rank.convName).toBe("");
        expect(rank.convShortName).toBe("");
    });
});
