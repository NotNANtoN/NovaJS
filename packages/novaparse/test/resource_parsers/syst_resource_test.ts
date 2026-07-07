import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { SystResource } from "../../src/resource_parsers/syst_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

import { resolveFixture } from "../../test/fixtures.js";

/** A sÿst resource with every field set to a distinct, recognizable value. */
function buildSyst(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(42).int16(-84)                          // position
        .array([129, 163, ...Array(14).fill(-1)], v => b.int16(v))  // links
        .array([128, 189, ...Array(14).fill(-1)], v => b.int16(v))  // spobs
        .array([130, 174, ...Array(6).fill(-1)], v => b.int16(v))   // dude ids
        .array([17, 13, 0, 0, 0, 0, 0, 0], v => b.int16(v))         // dude chances
        .int16(6)                                   // avgShips
        .int16(128)                                 // govt
        .int16(999)                                 // messageBuoy
        .int16(2)                                   // asteroids
        .int16(30)                                  // interference
        .array([510, ...Array(7).fill(-1)], v => b.int16(v))        // pers ids
        .array([50, 0, 0, 0, 0, 0, 0, 0], v => b.int16(v))          // pers chances
        .uint32(0x00102030)                         // backgroundColor
        .int16(25)                                  // murk
        .uint16(0b1001100010001)                    // asteroidTypes
        .string("!(b147 | b305)", 0x100)            // visibility
        .int16(145)                                 // reinforcementFleet
        .int16(480)                                 // reinforcementTime
        .int16(1)                                   // reinforcementInterval
        .skip(0x10);                                // unused
    return b;
}

describe("SystResource", () => {
    // Systs don't depend on other resources.
    const idSpace = defaultIDSpace;

    let rf: ResourceMap;
    let s1: SystResource;
    let s2: SystResource;

    beforeEach(async () => {
        const dataPath = resolveFixture("resource_examples/syst.ndat");
        rf = await readResourceFork(dataPath, false);
        const systs = rf.sÿst;
        s1 = new SystResource(systs[128], idSpace);
        s2 = new SystResource(systs[129], idSpace);
    });

    it("should parse position", () => {
        expect(s1.position).toEqual([42, 84]);
        expect(s2.position).toEqual([-28, -96]);
    });

    it("should parse links", () => {
        expect(s1.links).toEqual(new Set([129, 163]));
        expect(s2.links).toEqual(new Set([128, 163]));
    });

    it("should parse spobs", () => {
        expect(s1.spobs).toEqual([128, 189, 194]);
    });

    describe("with built resources", () => {
        let syst: SystResource;

        beforeEach(() => {
            syst = new SystResource(
                buildSyst().resource("sÿst", 128, "Test System"), idSpace);
        });

        it("builds a full-size resource", () => {
            // 428 bytes is the size of every sÿst in Nova's own data files.
            expect(buildSyst().byteLength).toBe(428);
        });

        it("parses position, links, and spobs", () => {
            expect(syst.position).toEqual([42, -84]);
            expect(syst.links).toEqual(new Set([129, 163]));
            expect(syst.spobs).toEqual([128, 189]);
        });

        it("zips dude spawn chances, dropping unused entries", () => {
            expect(syst.dudes).toEqual([
                { id: 130, chance: 17 },
                { id: 174, chance: 13 },
            ]);
        });

        it("parses ship traffic fields", () => {
            expect(syst.avgShips).toBe(6);
            expect(syst.govt).toBe(128);
            expect(syst.messageBuoy).toBe(999);
        });

        it("parses environment fields", () => {
            expect(syst.asteroids).toBe(2);
            expect(syst.interference).toBe(30);
            expect(syst.backgroundColor).toBe(0x00102030);
            expect(syst.murk).toBe(25);
            expect(syst.asteroidTypes).toBe(0b1001100010001);
        });

        it("zips pers spawn chances", () => {
            expect(syst.persons).toEqual([{ id: 510, chance: 50 }]);
        });

        it("parses visibility", () => {
            expect(syst.visibility).toBe("!(b147 | b305)");
        });

        it("parses reinforcement fields", () => {
            expect(syst.reinforcementFleet).toBe(145);
            expect(syst.reinforcementTime).toBe(480);
            expect(syst.reinforcementInterval).toBe(1);
        });

        it("defaults fields past the end of a truncated resource", () => {
            // Cut off immediately after interference.
            const truncated = buildSyst().truncate(110);
            const syst = new SystResource(
                truncated.resource("sÿst", 129, "Truncated"), idSpace);
            expect(syst.interference).toBe(30);
            expect(syst.persons).toEqual([]);
            expect(syst.visibility).toBe("");
            expect(syst.reinforcementFleet).toBe(-1);
        });
    });
});
