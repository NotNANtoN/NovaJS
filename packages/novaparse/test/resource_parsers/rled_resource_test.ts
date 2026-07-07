import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { RledResource } from "../../src/resource_parsers/rled_resource.js";
import { PNG } from "pngjs";
import { getPNG, getFrames, applyMask, PNGCustomMatchers } from "./png_compare.js"
import { defaultIDSpace } from "./default_id_space.js";

declare global {
    namespace jasmine {
        interface Matchers<T> {
            toEqualPNG(expected: unknown): boolean
        }
    }
}

jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000; // 30 seconds

import { resolveFixture } from "../../test/fixtures.js";

describe("RledResource", () => {
    let rf: ResourceMap;
    let starbridge: RledResource;
    let leviathan: RledResource;
    let starbridgePNG: PNG;
    let starbridgeMask: PNG;
    let leviathanPNG: PNG;
    let leviathanMask: PNG;

    // Rleds don't depend on other resources.
    const idSpace = defaultIDSpace;

    beforeEach(async () => {
        jasmine.addMatchers(PNGCustomMatchers);

        starbridgePNG = await getPNG(resolveFixture(
            "resource_examples/rleds/starbridge.png"));
        starbridgeMask = await getPNG(resolveFixture(
            "resource_examples/rleds/starbridge_mask.png"));
        leviathanPNG = await getPNG(resolveFixture(
            "resource_examples/rleds/leviathan.png"));
        leviathanMask = await getPNG(resolveFixture(
            "resource_examples/rleds/leviathan_mask.png"));

        const dataPath = resolveFixture("resource_examples/rled.ndat");
        rf = await readResourceFork(dataPath, false);

        const rleds = rf.rlëD;
        starbridge = new RledResource(rleds[1010], idSpace);
        leviathan = new RledResource(rleds[1006], idSpace);
        expect(starbridge).toBeDefined();
        expect(leviathan).toBeDefined();
    });

    it("should produce an ordered array of frames", () => {
        const starbridgeApplied = applyMask(starbridgePNG, starbridgeMask);
        const leviathanApplied = applyMask(leviathanPNG, leviathanMask);

        const expectedStarbridgeFrames = getFrames(starbridgeApplied, { width: 48, height: 48 });
        const expectedLeviathanFrames = getFrames(leviathanApplied, { width: 144, height: 144 });

        const parsedStarbridgeFrames = starbridge.frames;
        const parsedLeviathanFrames = leviathan.frames

        expect(parsedStarbridgeFrames.length).toEqual(expectedStarbridgeFrames.length);
        expect(parsedLeviathanFrames.length).toEqual(expectedLeviathanFrames.length);

        for (let i = 0; i < parsedStarbridgeFrames.length; i++) {
            expect(expectedStarbridgeFrames[i]).toEqualPNG(parsedStarbridgeFrames[i]);
        }

        for (let i = 0; i < parsedLeviathanFrames.length; i++) {
            expect(expectedLeviathanFrames[i]).toEqualPNG(parsedLeviathanFrames[i]);
        }
    });
});
