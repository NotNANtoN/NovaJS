import "jasmine";
import { NovaResources, getEmptyNovaResources } from "../src/resource_parsers/ResourceHolderBase.js";
import { readNovaFile } from "../src/readNovaFile.js";
import { resolveFixture } from "./fixtures.js";

describe("readNovaFile", function() {
    const shipPath = resolveFixture("resource_examples/ship.ndat");
    let localIDSpace: NovaResources;

    beforeEach(async function() {
        localIDSpace = getEmptyNovaResources();
        await readNovaFile(shipPath, localIDSpace);
    });

    it("should parse resources", function() {
        expect(localIDSpace["shïp"][128].name).toEqual("contrived ship test");
    })
});

