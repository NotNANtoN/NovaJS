import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { SystResource } from "../../src/resource_parsers/SystResource.js";
import { defaultIDSpace } from "./DefaultIDSpace.js";

import { resolveFixture } from "../../test/fixtures.js";

describe("SystResource", function() {
    // Systs don't depend on other resources.
    const idSpace = defaultIDSpace;

    let rf: ResourceMap;
    let s1: SystResource;
    let s2: SystResource;

    beforeEach(async function() {
        const dataPath = resolveFixture("resource_examples/syst.ndat");
        rf = await readResourceFork(dataPath, false);
        const systs = rf.sÿst;
        s1 = new SystResource(systs[128], idSpace);
        s2 = new SystResource(systs[129], idSpace);
    });

    it("should parse position", function() {
        expect(s1.position).toEqual([42, 84]);
        expect(s2.position).toEqual([-28, -96]);
    });

    it("should parse links", function() {
        expect(s1.links).toEqual(new Set([129, 163]));
        expect(s2.links).toEqual(new Set([128, 163]));
    });

    it("should parse spobs", function() {
        expect(s1.spobs).toEqual([128, 189, 194]);
    });
});
