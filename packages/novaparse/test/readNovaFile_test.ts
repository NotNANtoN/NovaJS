import "jasmine";
import { NovaResources, getEmptyNovaResources } from "../src/resource_parsers/ResourceHolderBase.js";
import { readNovaFile } from "../src/readNovaFile.js";

// Bazel no longer patches require.
const runfiles = require(process.env['BAZEL_NODE_RUNFILES_HELPER'] as string) as typeof require;

describe("readNovaFile", function() {

    const shipPath = runfiles.resolve("novajs/novaparse/test/resource_parsers/files/ship.ndat");
    let localIDSpace: NovaResources;

    beforeEach(async function() {
        localIDSpace = getEmptyNovaResources();
        await readNovaFile(shipPath, localIDSpace);
    });

    it("should parse resources", function() {
        expect(localIDSpace["shïp"][128].name).toEqual("contrived ship test");
    })
});

