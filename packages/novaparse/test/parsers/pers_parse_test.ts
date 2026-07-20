import "jasmine";
import { PersResource } from "../../src/resource_parsers/pers_resource.js";
import { StrNResource } from "../../src/resource_parsers/strn_resource.js";
import { PersParse } from "../../src/parsers/pers_parse.js";
import { getEmptyNovaResources, NovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/** Builds a STR# resource holding the given strings. */
function makeStrN(idSpace: NovaResources, id: number, strings: string[]) {
    const b = new ResourceBuilder();
    b.uint16(strings.length);
    for (const s of strings) {
        b.pstring(s);
    }
    idSpace["STR#"][id] = new StrNResource(
        b.resource("STR#", id, `strings ${id}`), idSpace);
}

/** An id space stubbed with just the globalIDs the parser resolves. */
function makeIdSpace(): NovaResources {
    const idSpace = getEmptyNovaResources();
    const stub = (globalID: string) => ({ globalID }) as never;
    idSpace.shïp[150] = stub("nova:150");
    idSpace.gövt[133] = stub("nova:133");
    idSpace.gövt[200] = stub("nova:200");
    idSpace.sÿst[400] = stub("nova:400");
    idSpace.wëap[300] = stub("nova:300");
    idSpace.wëap[301] = stub("nova:301");
    idSpace.mïsn[400] = stub("nova:400");
    idSpace.PICT[4001] = stub("nova:4001");
    makeStrN(idSpace, 7100, ["comm one", "comm two"]);
    makeStrN(idSpace, 7101, ["hail one", "hail two", "hail three"]);
    return idSpace;
}

/** Mirrors the layout exercised in pers_resource_test.ts. */
function buildPers(linkSystem: number): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(linkSystem)                     // linkSystem
        .int16(200)                         // govt
        .int16(3)                           // aiType
        .int16(2)                           // aggression
        .int16(25)                          // cowardice
        .int16(150)                         // shipType
        .array([300, 301, -1, 302], v => b.int16(v))  // weapon ids
        .array([1, 2, 3, 4], v => b.int16(v))         // counts
        .array([50, 60, 70, 80], v => b.int16(v))     // ammo
        .int32(50000)                       // credits
        .int16(130)                         // shieldMod
        .int16(4001)                        // hailPict
        .int16(2)                           // commQuote (1-based)
        .int16(3)                           // hailQuote (1-based)
        .int16(400)                         // linkMission
        .uint16(0x8043)                     // flags
        .string("b128 !b200", 256)          // activeOn
        .int16(5)                           // grantClass
        .int16(3)                           // grantCount
        .int16(75)                          // grantChance
        .string("the Rebel Hero", 64)       // subtitle
        .uint32(0x00ff8800)                 // color
        .uint16(0x0001)                     // flags2
        .skip(16);                          // unused
    return b;
}

function parsePers(linkSystem = -1) {
    const resource = new PersResource(
        buildPers(linkSystem).resource("përs", 128, "Rebel Hero"),
        makeIdSpace());
    resource.globalID = "nova:128";
    resource.prefix = "nova";
    return PersParse(resource, () => { });
}

describe("PersParse", () => {
    it("carries the BaseData fields (the person's name)", async () => {
        const pers = await parsePers();
        expect(pers.id).toBe("nova:128");
        expect(pers.name).toBe("Rebel Hero");
        expect(pers.prefix).toBe("nova");
    });

    it("resolves the ship and govt to global ids", async () => {
        const pers = await parsePers();
        expect(pers.ship).toBe("nova:150");
        expect(pers.govt).toBe("nova:200");
    });

    it("projects the character traits", async () => {
        const pers = await parsePers();
        expect(pers.aiType).toBe(3);
        expect(pers.aggression).toBe(2);
        expect(pers.cowardice).toBe(25);
        expect(pers.credits).toBe(50000);
        expect(pers.shieldMod).toBe(130);
        expect(pers.subtitle).toBe("the Rebel Hero");
        expect(pers.color).toBe(0x00ff8800);
        expect(pers.startsWithNoFuel).toBe(true);
        expect(pers.activeOn).toBe("b128 !b200");
    });

    it("resolves loadout weapons to global ids, dropping missing ones",
        async () => {
            const pers = await parsePers();
            // Slot 3 (-1) was dropped by the resource parser; slot 4
            // (302) is missing from the id space and dropped here.
            expect(pers.weapons).toEqual([
                { id: "nova:300", count: 1, ammo: 50 },
                { id: "nova:301", count: 2, ammo: 60 },
            ]);
        });

    it("resolves the link mission and hail pict", async () => {
        const pers = await parsePers();
        expect(pers.linkMission).toBe("nova:400");
        expect(pers.hailPict).toBe("nova:4001");
    });

    it("resolves the 1-based comm/hail quotes from STR# 7100/7101",
        async () => {
            const pers = await parsePers();
            expect(pers.commQuote).toBe("comm two");
            expect(pers.hailQuote).toBe("hail three");
        });

    it("decodes flags into named booleans", async () => {
        const pers = await parsePers();
        // 0x8043 = keepsGrudge | usesEscapePodAndAfterburner
        //          | replaceWithSpecialShip | showDisasterInfoWhenHailing
        expect(pers.flags.keepsGrudge).toBe(true);
        expect(pers.flags.usesEscapePodAndAfterburner).toBe(true);
        expect(pers.flags.replaceWithSpecialShip).toBe(true);
        expect(pers.flags.showDisasterInfoWhenHailing).toBe(true);
        expect(pers.flags.hailOnlyWithGrudge).toBe(false);
        expect(pers.flags.deactivateAfterMission).toBe(false);
    });

    it("projects the boarding grant fields", async () => {
        const pers = await parsePers();
        expect(pers.grantClass).toBe(5);
        expect(pers.grantCount).toBe(3);
        expect(pers.grantChance).toBe(75);
    });

    it("parses LinkSyst -1 as any system", async () => {
        expect((await parsePers(-1)).linkSyst).toEqual({ type: 'any' });
    });

    it("parses a specific-system LinkSyst to a global system id", async () => {
        expect((await parsePers(400)).linkSyst)
            .toEqual({ type: 'system', id: 'nova:400' });
    });

    it("parses LinkSyst 9999 as independent systems", async () => {
        expect((await parsePers(9999)).linkSyst)
            .toEqual({ type: 'independentSystems' });
    });

    it("parses the govt-relative LinkSyst ranges", async () => {
        expect((await parsePers(10005)).linkSyst)
            .toEqual({ type: 'govtSystems', govt: 'nova:133' });
        expect((await parsePers(15005)).linkSyst)
            .toEqual({ type: 'allySystems', govt: 'nova:133' });
        expect((await parsePers(20005)).linkSyst)
            .toEqual({ type: 'notGovtSystems', govt: 'nova:133' });
        expect((await parsePers(25005)).linkSyst)
            .toEqual({ type: 'enemySystems', govt: 'nova:133' });
    });

    it("degrades a missing LinkSyst reference to any system", async () => {
        // sÿst 500 and gövt 170 (10042) are not in the id space.
        expect((await parsePers(500)).linkSyst).toEqual({ type: 'any' });
        expect((await parsePers(10042)).linkSyst).toEqual({ type: 'any' });
    });

    it("is JSON-safe end to end", async () => {
        const pers = await parsePers();
        expect(() => JSON.stringify(pers)).not.toThrow();
    });
});
