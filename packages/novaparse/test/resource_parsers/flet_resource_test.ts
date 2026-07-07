import "jasmine";
import { FletResource } from "../../src/resource_parsers/flet_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A flët resource with every field set to a distinct, recognizable value. */
function buildFlet(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(200)                                // leadShip
        .array([201, 202, -1, -1], v => b.int16(v))   // escort ids
        .array([1, 2, 0, 0], v => b.int16(v))         // mins
        .array([3, 4, 0, 0], v => b.int16(v))         // maxes
        .int16(150)                             // govt
        .int16(10005)                           // linkSyst
        .string("b128 !b129", 0x100)            // appearOn (NCB)
        .int16(7000)                            // quote
        .uint16(0x0001)                         // flags
        .skip(16);                              // unused
    return b;
}

describe("FletResource", () => {
    // Fleets don't depend on other resources.
    const idSpace = defaultIDSpace;

    let flet: FletResource;

    beforeEach(() => {
        flet = new FletResource(
            buildFlet().resource("flët", 128, "Test Fleet"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 306 bytes is the size of every flët in Nova's own data files.
        expect(buildFlet().byteLength).toBe(306);
    });

    it("parses leadShip", () => {
        expect(flet.leadShip).toBe(200);
    });

    it("zips escort ids, mins, and maxes, dropping unused entries", () => {
        expect(flet.escorts).toEqual([
            { id: 201, min: 1, max: 3 },
            { id: 202, min: 2, max: 4 },
        ]);
    });

    it("parses govt and linkSyst", () => {
        expect(flet.govt).toBe(150);
        expect(flet.linkSyst).toBe(10005);
    });

    it("parses appearOn and quote", () => {
        expect(flet.appearOn).toBe("b128 !b129");
        expect(flet.quote).toBe(7000);
    });

    it("parses flags", () => {
        expect(flet.flags).toBe(0x0001);
        expect(flet.freightersRandomCargo).toBe(true);
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off in the middle of the escort mins.
        const truncated = buildFlet().truncate(12);
        const flet = new FletResource(
            truncated.resource("flët", 129, "Truncated"), idSpace);
        expect(flet.leadShip).toBe(200);
        // The first escort's min is present; its max is past the end (0).
        expect(flet.escorts).toEqual([
            { id: 201, min: 1, max: 0 },
            { id: 202, min: 0, max: 0 },
        ]);
        expect(flet.govt).toBe(-1);
        expect(flet.appearOn).toBe("");
        expect(flet.quote).toBe(-1);
    });
});
