import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { SpobResource } from "../../src/resource_parsers/SpobResource.js";
import { defaultIDSpace } from "./DefaultIDSpace.js";

import { resolveFixture } from "../../test/fixtures.js";

describe("SpobResource", () => {
    // Spobs don't depend on other resources.
    const idSpace = defaultIDSpace;

    let rf: ResourceMap;
    let p1: SpobResource;
    let p2: SpobResource;

    beforeEach(async () => {
        const dataPath = resolveFixture("resource_examples/spob.ndat");
        rf = await readResourceFork(dataPath, false);
        const spobs = rf.spöb;
        p1 = new SpobResource(spobs[128], idSpace);
        p2 = new SpobResource(spobs[129], idSpace);
    });

    it("should parse position", () => {
        expect(p1.position).toEqual([123, 456]);
        expect(p2.position).toEqual([-321, -42]);
    });

    it("should parse graphic", () => {
        expect(p1.graphic).toEqual(2042);
        expect(p2.graphic).toEqual(2060);
    });

    it("should parse government", () => {
        expect(p1.government).toEqual(190);
        expect(p2.government).toEqual(163);

    });

    it("should parse techLevel", () => {
        expect(p1.techLevel).toEqual(72);
        expect(p2.techLevel).toEqual(15000);
    });

    it("should parse landingPictID", () => {
        expect(p1.landingPictID).toEqual(10003);
        expect(p2.landingPictID).toEqual(10042);

    });

    it("should set landingDescID", () => {
        expect(p1.landingDescID).toEqual(128);
        expect(p2.landingDescID).toEqual(129);
    });
});

