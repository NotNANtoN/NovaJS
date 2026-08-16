import "jasmine";
import { RankParse } from "../../src/parsers/rank_parse.js";
import { GovtResource } from "../../src/resource_parsers/govt_resource.js";
import { RankResource } from "../../src/resource_parsers/rank_resource.js";
import { getEmptyNovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/**
 * The ränk template, in field order (EVN Bible, ränk section): Weight,
 * AffilGovt, PriceMod (int16 each), Salary, SalaryCap (int32), Contribute
 * (64 bits), Flags (uint16), then the two 64-byte text fields ConvName and
 * ShortName.
 */
function buildRank(over: {
    weight?: number, affilGovt?: number, priceMod?: number,
    salary?: number, salaryCap?: number, contribute?: bigint,
    flags?: number, convName?: string, shortName?: string,
} = {}): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(over.weight ?? 0)
        .int16(over.affilGovt ?? -1)
        .int16(over.priceMod ?? 100)
        .int32(over.salary ?? 0)
        .int32(over.salaryCap ?? 0)
        .uint64(over.contribute ?? 0n)
        .uint16(over.flags ?? 0)
        .string(over.convName ?? "", 64)
        .string(over.shortName ?? "", 64);
    return b;
}

function parseRank(over: Parameters<typeof buildRank>[0] = {},
    name = "A Rank", withGovt = true) {
    const idSpace = getEmptyNovaResources();
    if (withGovt) {
        // A gövt for AffilGovt to resolve against. Only its globalID is read.
        const govt = new GovtResource(
            new ResourceBuilder().resource("gövt", 183, "Hypergate"), idSpace);
        govt.globalID = "nova:183";
        govt.prefix = "nova";
        idSpace["gövt"][183] = govt;
    }
    const resource = new RankResource(
        buildRank(over).resource("ränk", 147, name), idSpace);
    resource.globalID = "nova:147";
    resource.prefix = "nova";
    resource.writerPrefix = "nova";
    const missing: string[] = [];
    return {
        missing,
        data: RankParse(resource, m => { missing.push(m); }),
    };
}

describe("RankParse", () => {
    it("carries the BaseData fields; the resource NAME is the full rank "
        + "name shown in the player-info dialog", async () => {
            const data = await parseRank({}, "Knight of Red Branch").data;
            expect(data.id).toBe("nova:147");
            expect(data.name).toBe("Knight of Red Branch");
            expect(data.prefix).toBe("nova");
        });

    it("resolves AffilGovt to a GLOBAL govt id", async () => {
        expect((await parseRank({ affilGovt: 183 }).data).affilGovt)
            .toBe("nova:183");
    });

    it("reads AffilGovt -1 as no affiliation, without complaining", async () => {
        const parsed = parseRank({ affilGovt: -1 });
        expect((await parsed.data).affilGovt).toBeNull();
        expect(parsed.missing).toEqual([]);
    });

    it("reports an AffilGovt that names a govt which does not exist",
        async () => {
            const parsed = parseRank({ affilGovt: 999 });
            expect((await parsed.data).affilGovt).toBeNull();
            expect(parsed.missing.length).toBe(1);
        });

    it("carries Weight, PriceMod, Salary and SalaryCap verbatim", async () => {
        const data = await parseRank({
            weight: 30, priceMod: 60, salary: 500, salaryCap: 350_000,
        }).data;
        expect(data.weight).toBe(30);
        expect(data.priceMod).toBe(60);
        expect(data.salary).toBe(500);
        expect(data.salaryCap).toBe(350_000);
    });

    it("carries Contribute as a DECIMAL string, like cron/mission "
        + "Contribute", async () => {
            expect((await parseRank({ contribute: 528280977408n }).data)
                .contribute).toBe("528280977408");
            expect((await parseRank({}).data).contribute).toBe("0");
        });

    it("decodes every documented Flags bit", async () => {
        const all = await parseRank({ flags: 0x0f7f }).data;
        expect(all.rankFlags).toEqual({
            dropOtherRanksWhenActivated: true,
            dropOtherRanksWhenDeactivated: true,
            dropIfDestroyGovtOrAllyShip: true,
            permanent: true,
            dropLowerRanksWhenActivated: true,
            dropLowerRanksWhenDeactivated: true,
            dropIfCrimeAgainstGovt: true,
            govtShipsWontAttack: true,
            canAlwaysLandOnGovtStellars: true,
            canRequestBattleAssistance: true,
            freeRefuelAndRepair: true,
        });
        const none = await parseRank({ flags: 0 }).data;
        expect(Object.values(none.rankFlags).some(v => v)).toBeFalse();
        // The raw word is kept so unmodelled bits stay inspectable.
        expect(all.flags).toBe(0x0f7f);
    });

    it("decodes the stock hypergate rank's 0x0208 exactly", async () => {
        // ränk nova:147 "Have Access to Hypergate System": 0x0200 (land
        // regardless of MinStatus) | 0x0008 (permanent), and nothing else.
        const data = await parseRank({ flags: 0x0208 }).data;
        expect(data.rankFlags.canAlwaysLandOnGovtStellars).toBeTrue();
        expect(data.rankFlags.permanent).toBeTrue();
        expect(data.rankFlags.govtShipsWontAttack).toBeFalse();
        expect(data.rankFlags.dropOtherRanksWhenActivated).toBeFalse();
    });

    it("carries ConvName and ShortName", async () => {
        const data = await parseRank({
            convName: "Space Marshall", shortName: "Marshall",
        }).data;
        expect(data.convName).toBe("Space Marshall");
        expect(data.shortName).toBe("Marshall");
    });
});
