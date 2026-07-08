import "jasmine";
import { NovaResources, getEmptyNovaResources } from "../src/resource_parsers/resource_holder_base.js";
import { readNovaFile } from "../src/read_nova_file.js";
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

