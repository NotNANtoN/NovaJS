import "jasmine";
import { RoidResource } from "../../src/resource_parsers/roid_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A röid resource with every field set to a distinct, recognizable value. */
function buildRoid(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(500)                                // strength
        .int16(100)                             // spinRate
        .int16(4)                               // yieldType (Metal)
        .int16(6)                               // yieldQuantity
        .int16(25)                              // particleCount
        .uint32(0x00ff8800)                     // particleColor
        .int16(130)                             // fragType 1
        .int16(131)                             // fragType 2
        .int16(3)                               // fragCount
        .int16(1005)                            // explodeType (sparks)
        .int16(80)                              // mass
        .skip(16);                              // unused
    return b;
}

describe("RoidResource", () => {
    // Asteroids don't depend on other resources.
    const idSpace = defaultIDSpace;

    let roid: RoidResource;

    beforeEach(() => {
        roid = new RoidResource(
            buildRoid().resource("röid", 128, "Test Asteroid"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 40 bytes is the size of every röid in Nova's own data files.
        expect(buildRoid().byteLength).toBe(40);
    });

    it("parses strength and spinRate", () => {
        expect(roid.strength).toBe(500);
        expect(roid.spinRate).toBe(100);
    });

    it("parses yield fields", () => {
        expect(roid.yieldType).toBe(4);
        expect(roid.yieldQuantity).toBe(6);
    });

    it("parses particle fields", () => {
        expect(roid.particleCount).toBe(25);
        expect(roid.particleColor).toBe(0x00ff8800);
    });

    it("parses fragment fields, dropping unused entries", () => {
        expect(roid.fragTypes).toEqual([130, 131]);
        expect(roid.fragCount).toBe(3);
    });

    it("parses explodeType and mass", () => {
        expect(roid.explodeType).toBe(1005);
        expect(roid.mass).toBe(80);
    });

    it("drops unused fragment types", () => {
        const b = buildRoid();
        // Rewrite with only the second fragment type unused.
        const single = new ResourceBuilder();
        single.int16(500).int16(100).int16(4).int16(6).int16(25)
            .uint32(0x00ff8800)
            .int16(130)     // fragType 1
            .int16(-1)      // fragType 2 unused
            .int16(3).int16(1005).int16(80).skip(16);
        const roid = new RoidResource(
            single.resource("röid", 129, "Single Frag"), idSpace);
        expect(roid.fragTypes).toEqual([130]);
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off immediately after particleCount.
        const truncated = buildRoid().truncate(10);
        const roid = new RoidResource(
            truncated.resource("röid", 130, "Truncated"), idSpace);
        expect(roid.particleCount).toBe(25);
        expect(roid.particleColor).toBe(0);
        expect(roid.fragTypes).toEqual([]);
        expect(roid.explodeType).toBe(-1);
        expect(roid.mass).toBe(0);
    });
});
