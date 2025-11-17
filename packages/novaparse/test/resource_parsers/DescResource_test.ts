import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { DescResource } from "../../src/resource_parsers/DescResource.js";
import { defaultIDSpace } from "./DefaultIDSpace.js";
import { resolveFixture } from "../../test/fixtures.js";

describe("DescResource", function() {
    let d1: DescResource;
    let d2: DescResource;
    let rf: ResourceMap;

    // Descs don't depend on other resources.
    const idSpace = defaultIDSpace;

    beforeEach(async function() {
        const dataPath = resolveFixture("resource_examples/desc.ndat");
        rf = await readResourceFork(dataPath, false);

        const descs = rf.dësc;
        d1 = new DescResource(descs[128], idSpace);
        d2 = new DescResource(descs[129], idSpace);

    });

    it("Should parse the string in the desc", function() {
        expect(d1.text).toEqual("The first description has one line of text that you can read.");
        expect(d2.text).toEqual("This one has a graphic.");
    });
    // it("Should parse graphic", function() {
    //     expect(d2.graphic).to.equal(4214);
    // });
});
