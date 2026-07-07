import "jasmine";
import { JunkResource } from "../../src/resource_parsers/junk_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A jünk resource with every field set to a distinct, recognizable value. */
function buildJunk(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.array([200, 201, 202, -1, -1, -1, -1, -1], v => b.int16(v)) // soldAt x8
        .array([300, 301, -1, -1, -1, -1, -1, -1], v => b.int16(v)) // boughtAt x8
        .int16(1500)                            // basePrice
        .uint16(0x0003)                         // flags
        .uint16(0x0044)                         // scanMask
        .string("machine parts", 0x40)          // lcName
        .string("Parts", 0x40)                  // abbrev
        .string("b400", 0xff)                   // buyOn (NCB test)
        .string("b401 !b402", 0xff);            // sellOn (NCB test)
    return b;
}

describe("JunkResource", () => {
    // Junk resources don't depend on other resources.
    const idSpace = defaultIDSpace;

    let junk: JunkResource;

    beforeEach(() => {
        junk = new JunkResource(
            buildJunk().resource("jünk", 128, "Test Junk"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 676 bytes is the size of every jünk in Nova's own data files.
        expect(buildJunk().byteLength).toBe(676);
    });

    it("zips soldAt and boughtAt, dropping unused entries", () => {
        expect(junk.soldAt).toEqual([200, 201, 202]);
        expect(junk.boughtAt).toEqual([300, 301]);
    });

    it("parses basePrice", () => {
        expect(junk.basePrice).toBe(1500);
    });

    it("parses flags", () => {
        expect(junk.flags).toBe(0x0003);
        expect(junk.multiplies).toBe(true);
        expect(junk.decays).toBe(true);
    });

    it("parses scanMask", () => {
        expect(junk.scanMask).toBe(0x0044);
    });

    it("parses the names", () => {
        expect(junk.lcName).toBe("machine parts");
        expect(junk.abbrev).toBe("Parts");
    });

    it("parses the NCB expressions", () => {
        expect(junk.buyOn).toBe("b400");
        expect(junk.sellOn).toBe("b401 !b402");
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off after boughtAt[0] (16 bytes of soldAt + 2 of boughtAt).
        const truncated = buildJunk().truncate(18);
        const junk = new JunkResource(
            truncated.resource("jünk", 129, "Truncated"), idSpace);
        expect(junk.soldAt).toEqual([200, 201, 202]);
        // Only boughtAt[0] survives; the rest read back as -1 and drop out.
        expect(junk.boughtAt).toEqual([300]);
        expect(junk.basePrice).toBe(0);
        expect(junk.flags).toBe(0);
        expect(junk.lcName).toBe("");
        expect(junk.buyOn).toBe("");
    });
});
