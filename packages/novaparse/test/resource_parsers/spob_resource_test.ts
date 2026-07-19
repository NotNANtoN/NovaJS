import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { SpobResource } from "../../src/resource_parsers/spob_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

import { resolveFixture } from "../../test/fixtures.js";

describe("SpobResource", () => {
    // Spobs don't depend on other resources.
    const idSpace = defaultIDSpace;

    let rf: ResourceMap;
    let p1: SpobResource;
    let p2: SpobResource;

    beforeEach(async () => {
        const dataPath = resolveFixture("resource_examples/spob.ndat");
        rf = await readResourceFork(dataPath, false);
        const spobs = rf.spöb;
        p1 = new SpobResource(spobs[128], idSpace);
        p2 = new SpobResource(spobs[129], idSpace);
    });

    it("should parse position", () => {
        expect(p1.position).toEqual([123, 456]);
        expect(p2.position).toEqual([-321, -42]);
    });

    it("should parse graphic", () => {
        expect(p1.graphic).toEqual(2042);
        expect(p2.graphic).toEqual(2060);
    });

    it("should parse government", () => {
        expect(p1.government).toEqual(190);
        expect(p2.government).toEqual(163);

    });

    it("should parse techLevel", () => {
        expect(p1.techLevel).toEqual(72);
        expect(p2.techLevel).toEqual(15000);
    });

    it("should parse landingPictID", () => {
        expect(p1.landingPictID).toEqual(10003);
        expect(p2.landingPictID).toEqual(10042);

    });

    it("should set landingDescID", () => {
        expect(p1.landingDescID).toEqual(128);
        expect(p2.landingDescID).toEqual(129);
    });
});

/** A spöb with every field set to a distinct, recognizable value. */
function buildSpob(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(100).int16(200)             // position
        .int16(30)                      // graphic type (-> rlëD 2030)
        .uint32(0x0000004f)             // flags
        .int16(500)                     // tribute
        .int16(7)                       // techLevel
        .array([11, 12, 13], v => b.int16(v))   // specialTech (first 3)
        .int16(150)                     // government
        .int16(-5)                      // minStatus
        .uint16(10042)                  // landingPictID
        .int16(305)                     // ambientSound
        .int16(200)                     // defenseDude
        .int16(1082)                    // defenseCount
        .uint16(0x1000)                 // flags2 (hypergate)
        .int16(20)                      // animationDelay
        .int16(3)                       // frame0Bias
        .array([128, 200, -1, -1, -1, -1, -1, -1], v => b.int16(v)) // hyperlinks
        .string("OnDom", 0xff)          // onDominate
        .string("OnRel", 0xff)          // onRelease
        .int32(2500)                    // landingFee
        .int16(0)                       // gravity
        .int16(150)                     // weapon
        .int32(9000)                    // strength
        .int16(42)                      // deadType
        .int16(-1)                      // deadTime
        .int16(1005)                    // explosion (0..63 + 1000 sparks bias)
        .string("OnDest", 0xff)         // onDestroy
        .string("OnRegen", 0xff)        // onRegen
        .array([21, 22, 23, 24, 25], v => b.int16(v)); // specialTech (last 5)
    return b;
}

describe("SpobResource built fields", () => {
    const idSpace = defaultIDSpace;
    let s: SpobResource;

    beforeEach(() => {
        s = new SpobResource(buildSpob().resource("spöb", 200), idSpace);
    });

    it("parses the graphic type mapping", () => {
        expect(s.graphic).toEqual(2030);
    });

    it("parses all eight special tech slots", () => {
        expect(s.specialTech).toEqual([11, 12, 13, 21, 22, 23, 24, 25]);
    });

    it("parses the fields the old parser skipped", () => {
        expect(s.minStatus).toEqual(-5);
        expect(s.ambientSound).toEqual(305);
        expect(s.defenseDude).toEqual(200);
        expect(s.defenseCount).toEqual(1082);
        expect(s.flags2).toEqual(0x1000);
        expect(s.hyperlinks).toEqual([128, 200]);
        expect(s.onDominate).toEqual("OnDom");
        expect(s.onRelease).toEqual("OnRel");
        expect(s.landingFee).toEqual(2500);
        expect(s.weapon).toEqual(150);
        expect(s.strength).toEqual(9000);
        expect(s.deadType).toEqual(42);
        expect(s.onDestroy).toEqual("OnDest");
        expect(s.onRegen).toEqual("OnRegen");
    });

    it("decodes the hypergate flag from flags2 0x1000", () => {
        // buildSpob sets flags2 = 0x1000.
        expect(s.isHypergate).toBe(true);
        expect(s.isWormhole).toBe(false);
    });

    it("decodes the explosion + sparks bias", () => {
        expect(s.explosion).toEqual(5 + 128);
        expect(s.explosionSparks).toEqual(true);
    });

    it("preserves the existing fields", () => {
        expect(s.position).toEqual([100, 200]);
        expect(s.flags).toEqual(0x0000004f);
        expect(s.tribute).toEqual(500);
        expect(s.techLevel).toEqual(7);
        expect(s.government).toEqual(150);
        expect(s.landingPictID).toEqual(10042);
        expect(s.landingDescID).toEqual(200);
    });
});

