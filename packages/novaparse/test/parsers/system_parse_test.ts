import "jasmine";
import { SystemParse } from "../../src/parsers/system_parse.js";
import { SystResource } from "../../src/resource_parsers/syst_resource.js";
import { getEmptyNovaResources, NovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/** An id space stubbed with just the globalIDs the parser resolves. */
function makeIdSpace(): NovaResources {
    const idSpace = getEmptyNovaResources();
    const stub = (globalID: string) => ({ globalID }) as never;
    idSpace.sÿst[129] = stub("nova:129");
    idSpace.spöb[128] = stub("nova:128");
    idSpace.düde[130] = stub("nova:130");
    idSpace.gövt[128] = stub("nova:128");
    idSpace.përs[510] = stub("nova:510");
    idSpace.përs[511] = stub("nova:511");
    return idSpace;
}

/**
 * A sÿst listing përs 510 (2%), 511 (15%), and a missing përs 512 (30%)
 * in its Person fields.
 */
function buildSyst(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(42).int16(-84)                                          // position
        .array([129, ...Array(15).fill(-1)], v => b.int16(v))       // links
        .array([128, ...Array(15).fill(-1)], v => b.int16(v))       // spobs
        .array([130, ...Array(7).fill(-1)], v => b.int16(v))        // dude ids
        .array([100, 0, 0, 0, 0, 0, 0, 0], v => b.int16(v))         // dude chances
        .int16(6)                                                   // avgShips
        .int16(128)                                                 // govt
        .int16(-1)                                                  // messageBuoy
        .int16(0)                                                   // asteroids
        .int16(0)                                                   // interference
        .array([510, 511, 512, ...Array(5).fill(-1)], v => b.int16(v)) // pers ids
        .array([2, 15, 30, 0, 0, 0, 0, 0], v => b.int16(v))         // pers chances
        .uint32(0)                                                  // background
        .int16(0)                                                   // murk
        .uint16(0)                                                  // asteroidTypes
        .string("", 0x100)                                          // visibility
        .int16(-1)                                                  // reinf fleet
        .int16(0)                                                   // reinf time
        .int16(0)                                                   // reinf interval
        .skip(0x10);                                                // unused
    return b;
}

function parseSystem() {
    const resource = new SystResource(
        buildSyst().resource("sÿst", 128, "Test System"), makeIdSpace());
    resource.globalID = "nova:128";
    resource.prefix = "nova";
    return SystemParse(resource, () => { });
}

describe("SystemParse", () => {
    it("carries the BaseData fields", async () => {
        const system = await parseSystem();
        expect(system.id).toBe("nova:128");
        expect(system.name).toBe("Test System");
    });

    it("resolves the sÿst Person fields to global ids with their percent "
        + "chances, dropping people the id space doesn't have", async () => {
            const system = await parseSystem();
            expect(system.persons).toEqual([
                { id: "nova:510", chance: 2 },
                { id: "nova:511", chance: 15 },
                // përs 512 is not in the id space: dropped.
            ]);
        });

    it("stays JSON-serializable", async () => {
        const system = await parseSystem();
        expect(() => JSON.stringify(system)).not.toThrow();
    });
});
