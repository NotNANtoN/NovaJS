import "jasmine";
import { VersResource, VersStage } from "../../src/resource_parsers/vers_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A vers resource modelled on EV Nova's own "1.0.10" version resource. */
function buildVers(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.uint8(0x01)                   // major (BCD): 1
        .uint8(0x02)                // minor/bugfix nibbles: minor 0, bugfix 2
        .uint8(VersStage.beta)      // development stage
        .uint8(5)                   // prerelease revision
        .uint16(0)                  // region code
        .pstring("1.0.10")          // short version string
        .pstring("1996-2006 Ambrosia"); // long version string
    return b;
}

describe("VersResource", () => {
    // vers resources don't depend on other resources.
    const idSpace = defaultIDSpace;

    let vers: VersResource;

    beforeEach(() => {
        vers = new VersResource(
            buildVers().resource("vers", 1, ""), idSpace);
    });

    it("builds a resource of the expected size", () => {
        // 6-byte header + (1 + 6) + (1 + 18) = 6 + 7 + 19 = 32 bytes.
        expect(buildVers().byteLength).toBe(32);
    });

    it("parses the BCD major version", () => {
        expect(vers.major).toBe(1);
    });

    it("parses the minor and bugfix nibbles", () => {
        expect(vers.minor).toBe(0);
        expect(vers.bugfix).toBe(2);
    });

    it("decodes a two-digit BCD major version", () => {
        const b = new ResourceBuilder()
            .uint8(0x12)            // major (BCD): 12
            .uint8(0x34)            // minor 3, bugfix 4
            .uint8(VersStage.release)
            .uint8(0)
            .uint16(0)
            .pstring("12.3.4")
            .pstring("");
        const v = new VersResource(b.resource("vers", 2, ""), idSpace);
        expect(v.major).toBe(12);
        expect(v.minor).toBe(3);
        expect(v.bugfix).toBe(4);
    });

    it("decodes the development stage", () => {
        expect(vers.stage).toBe(VersStage.beta);
        expect(vers.isDevelopment).toBe(false);
        expect(vers.isAlpha).toBe(false);
        expect(vers.isBeta).toBe(true);
        expect(vers.isRelease).toBe(false);
    });

    it("parses the prerelease revision and region code", () => {
        expect(vers.prerelease).toBe(5);
        expect(vers.regionCode).toBe(0);
    });

    it("parses the version strings", () => {
        expect(vers.shortVersion).toBe("1.0.10");
        expect(vers.longVersion).toBe("1996-2006 Ambrosia");
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off after the development-stage byte.
        const truncated = buildVers().truncate(3);
        const v = new VersResource(
            truncated.resource("vers", 3, "Truncated"), idSpace);
        expect(v.major).toBe(1);
        expect(v.minor).toBe(0);
        expect(v.bugfix).toBe(2);
        expect(v.isBeta).toBe(true);
        expect(v.prerelease).toBe(0);
        expect(v.shortVersion).toBe("");
        expect(v.longVersion).toBe("");
    });
});
