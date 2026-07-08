import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { SpinResource } from "../../src/resource_parsers/spin_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { NovaResourceType } from "../../src/resource_parsers/resource_holder_base.js";
import { ResourceBuilder } from "./resource_builder.js";

import { resolveFixture } from "../../test/fixtures.js";

describe("SpinResource", () => {
    // Spins don't depend on other resources.
    const idSpace = defaultIDSpace;

    let rf: ResourceMap;
    let explosion: SpinResource;
    let blaster: SpinResource;

    beforeEach(async () => {
        const dataPath = resolveFixture("resource_examples/spin.ndat");
        rf = await readResourceFork(dataPath, false);
        var spins = rf.spïn;
        explosion = new SpinResource(spins[412], idSpace);
        blaster = new SpinResource(spins[3000], idSpace);
    });

    it("should parse imageType", () => {
        expect(explosion.imageType).toEqual(NovaResourceType.rlëD);
        expect(blaster.imageType).toEqual(NovaResourceType.rlëD);
    });

    it("should parse spriteID", () => {
        expect(explosion.spriteID).toEqual(4024);
        expect(blaster.spriteID).toEqual(200);
    });

    it("should parse maskID", () => {
        expect(explosion.maskID).toEqual(4025);
        expect(blaster.maskID).toEqual(201);
    });

    it("classifies a sprite by its reserved spriteID range", () => {
        // The heuristic keys off the spriteID field (the rlëD/PICT id), not
        // the spïn resource id; ids outside the reserved ranges are "Unknown".
        const b = new ResourceBuilder()
            .int16(450)     // spriteID in the explosion range (400-463)
            .int16(-1)      // maskID
            .int16(64).int16(64)    // spriteSize
            .int16(6).int16(6);     // spriteTiles
        const s = new SpinResource(b.resource("spïn", 200), idSpace);
        expect(s.usedFor).toEqual("Explosion");
        expect(explosion.usedFor).toEqual("Unknown");
    });

    it("should parse spriteSize", () => {
        expect(explosion.spriteSize).toEqual([145, 145]);
        expect(blaster.spriteSize).toEqual([35, 35]);
    });

    it("should parse spriteTiles", () => {
        expect(explosion.spriteTiles).toEqual([17, 1]);
        expect(blaster.spriteTiles).toEqual([6, 6]);
    });
});
