import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { ShanResource } from "../../src/resource_parsers/shan_resource.js";
import { blinkPattern, shipAnimationMode } from "../../src/parsers/shan_parse.js";
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

// Projection tests for the shän extra-frame Flags into the display-layer
// ShipAnimationMode, pinned against real stock ships in the fixture.
describe("ShanParse animationMode projection", () => {
    const idSpace = defaultIDSpace;
    let rf: ResourceMap;
    let shuttle: ShanResource;       // banking (0x0001)
    let asteroidMiner: ShanResource; // folding + unfoldWhenFiring (0x0082)
    let thunderforge: ShanResource;  // continuous (0x0008) + alt overlay

    beforeEach(async () => {
        const dataPath = resolveFixture("resource_examples/shan.ndat");
        rf = await readResourceFork(dataPath, false);
        const shans = rf.shän;
        shuttle = new ShanResource(shans[128], idSpace);
        asteroidMiner = new ShanResource(shans[379], idSpace);
        thunderforge = new ShanResource(shans[380], idSpace);
    });

    it("returns null for a banking ship (banking rides the left/right ranges)", () => {
        expect(shuttle.flags.extraFramePurpose).toEqual("banking");
        expect(shipAnimationMode(shuttle)).toBeNull();
    });

    it("emits the folding + unfoldWhenFiring mode for the asteroid miner", () => {
        // shän 379: 6 base sets of 36 frames, AnimDelay 5, unfolds to fire.
        expect(shipAnimationMode(asteroidMiner)).toEqual({
            purpose: "folding",
            baseSetCount: 6,
            framesPer: 36,
            setsPerSecond: 6, // 30 / AnimDelay(5)
            unfoldWhenFiring: true,
            stopWhenDisabled: false,
            hideAltWhenDisabled: false,
            hideLightsWhenDisabled: true,
        });
    });

    it("emits the continuous mode for a sequence-animated ship", () => {
        // shän 380 (Aurora Thunderforge): 0x0008 shown-in-sequence.
        const mode = shipAnimationMode(thunderforge);
        expect(mode?.purpose).toEqual("continuous");
        expect(mode?.unfoldWhenFiring).toBe(false);
        expect(mode?.setsPerSecond).toEqual(6);
    });
});
