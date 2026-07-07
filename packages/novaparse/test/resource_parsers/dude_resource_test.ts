import "jasmine";
import { DudeResource } from "../../src/resource_parsers/dude_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A düde resource with every field set to a distinct, recognizable value. */
function buildDude(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(3)                                  // aiType (Warship)
        .int16(150)                             // govt
        .uint16(0x0143)                         // flags
        .uint16(0xd234)                         // infoTypes (all bits + STR#)
        // 16 ship ids: only three used.
        .array([200, 201, 202, -1, -1, -1, -1, -1,
            -1, -1, -1, -1, -1, -1, -1, -1], v => b.int16(v))
        // 16 probabilities, parallel to the ids.
        .array([50, 30, 20, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0], v => b.int16(v))
        .skip(16);                              // unused
    return b;
}

describe("DudeResource", () => {
    // Dudes don't depend on other resources.
    const idSpace = defaultIDSpace;

    let dude: DudeResource;

    beforeEach(() => {
        dude = new DudeResource(
            buildDude().resource("düde", 128, "Test Dude"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 88 bytes is the size of every düde in Nova's own data files.
        expect(buildDude().byteLength).toBe(88);
    });

    it("parses aiType and govt", () => {
        expect(dude.aiType).toBe(3);
        expect(dude.govt).toBe(150);
    });

    it("parses flags", () => {
        expect(dude.flags).toBe(0x0143);
        expect(dude.carriesFood).toBe(true);
        expect(dude.carriesIndustrial).toBe(true);
        expect(dude.carriesMedical).toBe(false);
        expect(dude.carriesLuxury).toBe(false);
        expect(dude.carriesMetal).toBe(false);
        expect(dude.carriesEquipment).toBe(false);
        expect(dude.carriesMoney).toBe(true);
        expect(dude.immuneToPlayer).toBe(true);
    });

    it("parses infoTypes", () => {
        expect(dude.infoTypes).toBe(0xd234);
        expect(dude.hasGenericGovtHail).toBe(true);   // 0x8000
        expect(dude.hasSpecificAdvice).toBe(true);    // 0x4000
        expect(dude.hasDisasterInfo).toBe(false);     // 0x2000
        expect(dude.hasGoodPrices).toBe(true);        // 0x1000
        expect(dude.specificAdviceStrIndex).toBe(0x234);
    });

    it("zips ship ids and probabilities, dropping unused entries", () => {
        expect(dude.ships).toEqual([
            { id: 200, probability: 50 },
            { id: 201, probability: 30 },
            { id: 202, probability: 20 },
        ]);
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off immediately after infoTypes.
        const truncated = buildDude().truncate(8);
        const dude = new DudeResource(
            truncated.resource("düde", 129, "Truncated"), idSpace);
        expect(dude.infoTypes).toBe(0xd234);
        expect(dude.ships).toEqual([]);
    });
});
