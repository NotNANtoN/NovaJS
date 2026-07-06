import "jasmine";
import { OopsResource } from "../../src/resource_parsers/oops_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** An öops resource with every field set to a distinct, recognizable value. */
function buildOops(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(400)                                // stellar
        .int16(2)                               // commodity (medical)
        .int16(-50)                             // priceDelta
        .int16(14)                              // duration
        .int16(25)                              // freq
        .string("b200 !b201", 0x100)            // activateOn (NCB test)
        .skip(0x10);                            // unused
    return b;
}

describe("OopsResource", () => {
    // Oops resources don't depend on other resources.
    const idSpace = defaultIDSpace;

    let oops: OopsResource;

    beforeEach(() => {
        oops = new OopsResource(
            buildOops().resource("öops", 128, "Test Disaster"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 282 bytes is the size of every öops in Nova's own data files.
        expect(buildOops().byteLength).toBe(282);
    });

    it("parses stellar and commodity", () => {
        expect(oops.stellar).toBe(400);
        expect(oops.commodity).toBe(2);
    });

    it("parses priceDelta, duration, and freq", () => {
        expect(oops.priceDelta).toBe(-50);
        expect(oops.duration).toBe(14);
        expect(oops.freq).toBe(25);
    });

    it("parses activateOn", () => {
        expect(oops.activateOn).toBe("b200 !b201");
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off in the middle of the header.
        const truncated = buildOops().truncate(6);
        const oops = new OopsResource(
            truncated.resource("öops", 129, "Truncated"), idSpace);
        expect(oops.stellar).toBe(400);
        expect(oops.commodity).toBe(2);
        expect(oops.priceDelta).toBe(-50);
        // Past the end.
        expect(oops.duration).toBe(0);
        expect(oops.freq).toBe(0);
        expect(oops.activateOn).toBe("");
    });
});
