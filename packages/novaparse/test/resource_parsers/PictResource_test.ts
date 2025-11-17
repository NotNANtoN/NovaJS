import "jasmine";
import { PNG } from "pngjs";
import { readResourceFork, ResourceMap } from "resource_fork";
import { NovaResources } from "../../src/resource_parsers/ResourceHolderBase.js";
import { PictResource } from "../../src/resource_parsers/PictResource.js";
import { getPNG, PNGCustomMatchers } from "./PNGCompare.js";
import { defaultIDSpace } from "./DefaultIDSpace.js";


declare global {
    namespace jasmine {
        interface Matchers<T> {
            toEqualPNG(expected: unknown): boolean
        }
    }
}

import { resolveFixture } from "../../test/fixtures.js";

describe("PictResource", function() {
    let ship: PictResource;
    let landed: PictResource;
    let statusBar: PictResource;
    let targetImage: PictResource;

    let shipPNG: PNG;
    let landedPNG: PNG;
    let statusBarPNG: PNG;
    let targetImagePNG: PNG;
    let rf: ResourceMap;

    // Picts don't depend on other resources.
    const idSpace: NovaResources = defaultIDSpace;

    beforeEach(async function() {
        jasmine.addMatchers(PNGCustomMatchers);

        shipPNG = await getPNG(resolveFixture(
            "resource_examples/picts/ship.png"));
        landedPNG = await getPNG(resolveFixture(
            "resource_examples/picts/landed.png"));
        statusBarPNG = await getPNG(resolveFixture(
            "resource_examples/picts/statusBar.png"));
        targetImagePNG = await getPNG(resolveFixture(
            "resource_examples/picts/targetImage.png"));

        const dataPath = resolveFixture("resource_examples/pict.ndat");
        rf = await readResourceFork(dataPath, false);

        const picts = rf.PICT;
        ship = new PictResource(picts[20158], idSpace);
        landed = new PictResource(picts[10034], idSpace);
        statusBar = new PictResource(picts[700], idSpace);
        targetImage = new PictResource(picts[3000], idSpace);
    });

    it("should parse pict into a png", function() {
        expect(ship.png).toEqualPNG(shipPNG);
        expect(landed.png).toEqualPNG(landedPNG);
        expect(statusBar.png).toEqualPNG(statusBarPNG);
        expect(targetImage.png).toEqualPNG(targetImagePNG);
    });
});
