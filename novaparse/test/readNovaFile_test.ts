import "jasmine";
import { NovaResources, getEmptyNovaResources } from "../src/resource_parsers/ResourceHolderBase";
import { readNovaFile } from "../src/readNovaFile";
import { fixturePath } from "../../test/fixture_path";

describe("readNovaFile", function() {

    const shipPath = fixturePath("novaparse/test/resource_parsers/files/ship.ndat");
    let localIDSpace: NovaResources;

    beforeEach(async function() {
        localIDSpace = getEmptyNovaResources();
        await readNovaFile(shipPath, localIDSpace);
    });

    it("should parse resources", function() {
        expect(localIDSpace["shïp"][128].name).toEqual("contrived ship test");
    })
});

