import "jasmine";
import { NovaResources, getEmptyNovaResources } from "../src/resource_parsers/ResourceHolderBase.js";
import { readNovaFile } from "../src/readNovaFile.js";
import { resolveFixture } from "./fixtures.js";

describe("readNovaFile", () => {
    const shipPath = resolveFixture("resource_examples/ship.ndat");
    let localIDSpace: NovaResources;

    beforeEach(async () => {
        localIDSpace = getEmptyNovaResources();
        await readNovaFile(shipPath, localIDSpace);
    });

    it("should parse resources", () => {
        expect(localIDSpace["shïp"][128].name).toEqual("contrived ship test");
    })
});

