import "jasmine";
import { DudeResource } from "../../src/resource_parsers/dude_resource.js";
import { DudeParse } from "../../src/parsers/dude_parse.js";
import { getEmptyNovaResources, NovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/** An id space stubbed with just the globalIDs the parser resolves. */
function makeIdSpace(): NovaResources {
    const idSpace = getEmptyNovaResources();
    const stub = (globalID: string) => ({ globalID }) as never;
    idSpace.shïp[200] = stub("nova:200");
    idSpace.shïp[201] = stub("nova:201");
    idSpace.gövt[150] = stub("nova:150");
    return idSpace;
}

/** A düde pointing at ships 200, 201, and a missing 202. */
function buildDude(govt: number): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(3)                                  // aiType (warship)
        .int16(govt)                            // govt
        .uint16(0x0041)                         // flags (food | money)
        .uint16(0x8000)                         // infoTypes
        .array([200, 201, 202, ...Array(13).fill(-1)],
            (v: number) => b.int16(v))          // ship ids
        .array([40, 35, 25, ...Array(13).fill(0)],
            (v: number) => b.int16(v));         // probabilities
    return b;
}

function parseDude(govt = 150) {
    const resource = new DudeResource(
        buildDude(govt).resource("düde", 128, "Test Dude"), makeIdSpace());
    resource.globalID = "nova:128";
    resource.prefix = "nova";
    return DudeParse(resource, () => { });
}

describe("DudeParse", () => {
    it("carries the BaseData fields", async () => {
        const dude = await parseDude();
        expect(dude.id).toBe("nova:128");
        expect(dude.name).toBe("Test Dude");
    });

    it("projects the AI type", async () => {
        const dude = await parseDude();
        expect(dude.aiType).toBe(3);
    });

    it("resolves the govt to a global id", async () => {
        const dude = await parseDude();
        expect(dude.govt).toBe("nova:150");
    });

    it("maps govt -1 (independent) to null", async () => {
        const dude = await parseDude(-1);
        expect(dude.govt).toBeNull();
    });

    it("degrades a missing govt to independent", async () => {
        const dude = await parseDude(180);
        expect(dude.govt).toBeNull();
    });

    it("resolves ship classes to global ids with weights, dropping " +
        "missing ships", async () => {
            const dude = await parseDude();
            expect(dude.ships).toEqual([
                { id: "nova:200", weight: 40 },
                { id: "nova:201", weight: 35 },
                // shïp 202 is not in the id space: dropped.
            ]);
        });

    it("stays JSON-serializable", async () => {
        const dude = await parseDude();
        expect(() => JSON.stringify(dude)).not.toThrow();
    });
});
