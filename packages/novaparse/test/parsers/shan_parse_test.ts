import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { ShanResource } from "../../src/resource_parsers/shan_resource.js";
import { blinkPattern } from "../../src/parsers/shan_parse.js";
import { defaultIDSpace } from "../resource_parsers/default_id_space.js";
import { resolveFixture } from "../../test/fixtures.js";

// Projection tests for the shän blink fields into the display-layer
// BlinkPattern. Pinned against real stock ships so the field mapping (and the
// square-wave errata swap) is verified against actual Nova data.
describe("ShanParse blink projection", () => {
    const idSpace = defaultIDSpace;
    let rf: ResourceMap;
    let shuttle: ShanResource;    // square (double-blink) mode
    let thunderforge: ShanResource; // no blink

    beforeEach(async () => {
        const dataPath = resolveFixture("resource_examples/shan.ndat");
        rf = await readResourceFork(dataPath, false);
        const shans = rf.shän;
        shuttle = new ShanResource(shans[128], idSpace);
        thunderforge = new ShanResource(shans[380], idSpace);
    });

    it("maps a null (steady) blink to null", () => {
        expect(thunderforge.blink).toBeNull();
        expect(blinkPattern(thunderforge.blink)).toBeNull();
    });

    it("maps square-wave fields with the on/off errata swap", () => {
        // Raw shuttle values: a=4, b=1, c=2, d=20. Per the Bible errata,
        // BlinkValA is the on-time and BlinkValB the between-blink off-time.
        expect(shuttle.blink!.mode).toEqual("square");
        expect(blinkPattern(shuttle.blink)).toEqual({
            mode: "square",
            onFrames: 4,       // BlinkValA (on-time)
            offFrames: 1,      // BlinkValB (between-blink delay)
            blinksPerGroup: 2, // BlinkValC
            groupDelayFrames: 20, // BlinkValD
        });
    });

    it("maps triangle-wave fields", () => {
        // Synthetic pattern matching the stock Arachnid pulse (10,75,32,75).
        expect(blinkPattern({
            mode: "triangle", a: 10, b: 75, c: 32, d: 75,
        })).toEqual({
            mode: "triangle",
            minIntensity: 10,
            riseRate: 75,
            maxIntensity: 32,
            fallRate: 75,
        });
    });

    it("maps random-mode fields (D ignored)", () => {
        expect(blinkPattern({
            mode: "random", a: 5, b: 30, c: 12, d: 0,
        })).toEqual({
            mode: "random",
            minIntensity: 5,
            maxIntensity: 30,
            changeDelayFrames: 12,
        });
    });

    it("maps an unknown mode to null (steady)", () => {
        expect(blinkPattern({
            mode: "unknown", a: 1, b: 2, c: 3, d: 4,
        })).toBeNull();
    });
});
