import "jasmine";
import { NebuResource } from "../../src/resource_parsers/nebu_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A nëbu resource with every field set to a distinct, recognizable value. */
function buildNebu(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(120)                                // xPos
        .int16(-340)                            // yPos
        .int16(500)                             // xSize
        .int16(250)                             // ySize
        .string("b300", 0xff)                   // activeOn (NCB test)
        .string("b301 !b302", 0xff)             // onExplore (NCB set)
        .skip(0x10);                            // unused
    return b;
}

describe("NebuResource", () => {
    // Nebulae don't depend on other resources.
    const idSpace = defaultIDSpace;

    let nebu: NebuResource;

    beforeEach(() => {
        nebu = new NebuResource(
            buildNebu().resource("nëbu", 128, "Test Nebula"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 534 bytes is the size of every nëbu in Nova's own data files.
        expect(buildNebu().byteLength).toBe(534);
    });

    it("parses position", () => {
        expect(nebu.xPos).toBe(120);
        expect(nebu.yPos).toBe(-340);
    });

    it("parses size", () => {
        expect(nebu.xSize).toBe(500);
        expect(nebu.ySize).toBe(250);
    });

    it("parses the NCB expressions", () => {
        expect(nebu.activeOn).toBe("b300");
        expect(nebu.onExplore).toBe("b301 !b302");
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off in the middle of the position/size header.
        const truncated = buildNebu().truncate(4);
        const nebu = new NebuResource(
            truncated.resource("nëbu", 129, "Truncated"), idSpace);
        expect(nebu.xPos).toBe(120);
        expect(nebu.yPos).toBe(-340);
        // Past the end.
        expect(nebu.xSize).toBe(0);
        expect(nebu.ySize).toBe(0);
        expect(nebu.activeOn).toBe("");
        expect(nebu.onExplore).toBe("");
    });
});
