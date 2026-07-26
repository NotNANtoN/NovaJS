import "jasmine";
import { getDefaultPictData } from "novadatainterface/pict_data";
import { getEmptyNovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { SpobResource } from "../../src/resource_parsers/spob_resource.js";
import { PlanetParse } from "../../src/parsers/planet_parse.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/**
 * Builds a spöb resource with the given flags2 / hyperlinks / emergence angle
 * (CustSndID) / fee, leaving the other fields at recognizable defaults.
 */
function buildSpob(opts: {
    flags2: number,
    hyperlinks: number[],
    ambientSound: number,
    fee: number,
    type?: number,
    landingPictID?: number,
    animationDelay?: number,
}): ResourceBuilder {
    const links = [...opts.hyperlinks];
    while (links.length < 8) {
        links.push(-1);
    }
    const b = new ResourceBuilder();
    b.int16(100).int16(200)                    // position
        .int16(opts.type ?? 30)                // graphic type
        .uint32(0)                             // flags
        .int16(0)                              // tribute
        .int16(0)                              // techLevel
        .array([0, 0, 0], v => b.int16(v))     // specialTech (first 3)
        .int16(-1)                             // government
        .int16(0)                              // minStatus
        .int16(opts.landingPictID ?? 0)        // landingPictID (CustPicID)
        .int16(opts.ambientSound)              // ambientSound / emergence angle
        .int16(-1)                             // defenseDude
        .int16(0)                              // defenseCount
        .uint16(opts.flags2)                   // flags2
        .int16(opts.animationDelay ?? 0)       // animationDelay
        .int16(0)                              // frame0Bias
        .array(links, v => b.int16(v))         // hyperlinks
        .string("", 0xff)                      // onDominate
        .string("", 0xff)                      // onRelease
        .int32(opts.fee)                       // landingFee
        .int16(0)                              // gravity
        .int16(-1)                             // weapon
        .int32(0)                              // strength
        .int16(-1)                             // deadType
        .int16(-1)                             // deadTime
        .int16(-1)                             // explosion
        .string("", 0xff)                      // onDestroy
        .string("", 0xff)                      // onRegen
        .array([0, 0, 0, 0, 0], v => b.int16(v)); // specialTech (last 5)
    return b;
}

/**
 * Registers a spöb in the id space with a known global id so hyperlink
 * resolution (spöb local id -> global id) can find it.
 */
function registerSpob(idSpace: ReturnType<typeof getEmptyNovaResources>,
    localId: number, globalID: string) {
    const spob = new SpobResource(
        buildSpob({ flags2: 0, hyperlinks: [], ambientSound: -1, fee: 0 })
            .resource("spöb", localId), idSpace);
    spob.globalID = globalID;
    spob.prefix = "nova";
    idSpace.spöb[localId] = spob;
}

function parse(spob: SpobResource) {
    spob.globalID = "nova:200";
    spob.prefix = "nova";
    return PlanetParse(spob, () => { });
}

describe("PlanetParse gate projection", () => {
    let idSpace: ReturnType<typeof getEmptyNovaResources>;

    beforeEach(() => {
        idSpace = getEmptyNovaResources();
        registerSpob(idSpace, 1401, "nova:1401");
        registerSpob(idSpace, 1411, "nova:1411");
    });

    it("leaves gate null for an ordinary stellar", async () => {
        const spob = new SpobResource(
            buildSpob({ flags2: 0, hyperlinks: [], ambientSound: -1, fee: 0 })
                .resource("spöb", 200), idSpace);
        const planet = await parse(spob);
        expect(planet.gate).toBeNull();
        expect(planet.landingFee).toBe(0);
    });

    it("projects a hypergate with resolved destination global ids", async () => {
        const spob = new SpobResource(
            buildSpob({ flags2: 0x1000, hyperlinks: [1401, 1411], ambientSound: 90, fee: 500 })
                .resource("spöb", 200), idSpace);
        const planet = await parse(spob);
        expect(planet.gate).not.toBeNull();
        expect(planet.gate!.kind).toBe("hypergate");
        expect(planet.gate!.destinations).toEqual(["nova:1401", "nova:1411"]);
        expect(planet.gate!.emergenceAngle).toBe(90);
        expect(planet.landingFee).toBe(500);
    });

    it("projects a wormhole with defined links", async () => {
        const spob = new SpobResource(
            buildSpob({ flags2: 0x2000, hyperlinks: [1401], ambientSound: 0, fee: 0 })
                .resource("spöb", 200), idSpace);
        const planet = await parse(spob);
        expect(planet.gate!.kind).toBe("wormhole");
        expect(planet.gate!.destinations).toEqual(["nova:1401"]);
        expect(planet.gate!.emergenceAngle).toBe(0);
    });

    it("marks a link-less wormhole with an empty destination list (random)", async () => {
        const spob = new SpobResource(
            buildSpob({ flags2: 0x2000, hyperlinks: [], ambientSound: -1, fee: 0 })
                .resource("spöb", 200), idSpace);
        const planet = await parse(spob);
        expect(planet.gate!.kind).toBe("wormhole");
        expect(planet.gate!.destinations).toEqual([]);
        // Any CustSndID outside 0-359 (here -1) => random emergence direction.
        expect(planet.gate!.emergenceAngle).toBeNull();
    });
});

describe("PlanetParse stellar graphic (spïn -> rlëD resolution)", () => {
    let idSpace: ReturnType<typeof getEmptyNovaResources>;
    // The parser reads spïn.spriteID and rlëD.globalID; stub just those.
    const spin = (spriteID: number) => ({ spriteID }) as never;
    const rled = (globalID: string) => ({ globalID }) as never;

    beforeEach(() => {
        idSpace = getEmptyNovaResources();
    });

    function graphicOf(type: number): Promise<string> {
        const spob = new SpobResource(
            buildSpob({
                flags2: type === 59 ? 0x2000 : 0,
                hyperlinks: [], ambientSound: -1, fee: 0, type,
            }).resource("spöb", 200), idSpace);
        return parse(spob).then(p => p.animation.images.baseImage.id);
    }

    it("resolves Type through spïn (1000 + Type), not a linear 2000 + Type",
        async () => {
            // Wormhole: Type 59 -> spïn 1059 -> rlëD 2300 (NOT the linear
            // 2058 the spöb resource approximates). This is the long-standing
            // wormhole-graphic bug.
            idSpace.spïn[1059] = spin(2300);
            idSpace.rlëD[2300] = rled("nova:2300");
            expect(await graphicOf(59)).toBe("nova:2300");
        });

    it("resolves an ordinary planet through spïn (Earth: Type 0 -> rlëD 2000)",
        async () => {
            idSpace.spïn[1000] = spin(2000);
            idSpace.rlëD[2000] = rled("nova:2000");
            expect(await graphicOf(0)).toBe("nova:2000");
        });

    it("honors a spïn that remaps to a shared sprite (Type 33 -> rlëD 2000)",
        async () => {
            // Ring World II reuses rlëD 2000; the linear guess (2033) is a
            // missing sprite. The spïn lookup gets it right.
            idSpace.spïn[1033] = spin(2000);
            idSpace.rlëD[2000] = rled("nova:2000");
            expect(await graphicOf(33)).toBe("nova:2000");
        });

    it("falls back to the linear graphic approximation when no spïn exists",
        async () => {
            // No spïn 1030 registered; falls back to spob.graphic (2030).
            idSpace.rlëD[2030] = rled("nova:2030");
            expect(await graphicOf(30)).toBe("nova:2030");
        });

    it("carries the spöb AnimDelay through to PlanetData.animationDelay",
        async () => {
            const spob = new SpobResource(
                buildSpob({
                    flags2: 0, hyperlinks: [], ambientSound: -1, fee: 0,
                    animationDelay: 7,
                }).resource("spöb", 200), idSpace);
            const planet = await parse(spob);
            expect(planet.animationDelay).toBe(7);
        });
});

describe("PlanetParse landing picture", () => {
    let idSpace: ReturnType<typeof getEmptyNovaResources>;
    const stub = (globalID: string) => ({ globalID }) as never;

    beforeEach(() => {
        idSpace = getEmptyNovaResources();
    });

    it("uses the custom landscape PICT when CustPicID >= 128", async () => {
        idSpace.PICT[11000] = stub("nova:11000");
        idSpace.PICT[10034] = stub("nova:10034");
        const spob = new SpobResource(
            buildSpob({
                flags2: 0, hyperlinks: [], ambientSound: -1, fee: 0,
                type: 34, landingPictID: 11000,
            }).resource("spöb", 200), idSpace);
        const planet = await parse(spob);
        expect(planet.landingPict).toBe("nova:11000");
    });

    it("falls back to the standard landscape PICT (10000 + Type) when" +
        " CustPicID is -1 (regression: New England/Port Kane showed the" +
        " placeholder)", async () => {
        // Port Kane: Type 34, CustPicID -1 => PICT 10034, verified
        // pixel-identical to the original-hardware reference screenshot.
        idSpace.PICT[10034] = stub("nova:10034");
        const spob = new SpobResource(
            buildSpob({
                flags2: 0, hyperlinks: [], ambientSound: -1, fee: 0,
                type: 34, landingPictID: -1,
            }).resource("spöb", 200), idSpace);
        const planet = await parse(spob);
        expect(planet.landingPict).toBe("nova:10034");
    });

    it("keeps the default placeholder when neither a custom nor a standard" +
        " landscape PICT exists (hypergates, unlandable stellars)", async () => {
        const notFound: string[] = [];
        const spob = new SpobResource(
            buildSpob({
                flags2: 0, hyperlinks: [], ambientSound: -1, fee: 0,
                type: 64, landingPictID: -1,
            }).resource("spöb", 200), idSpace);
        spob.globalID = "nova:200";
        spob.prefix = "nova";
        const planet = await PlanetParse(spob, m => notFound.push(m));
        expect(planet.landingPict).toBe(getDefaultPictData().id);
        expect(notFound.some(m => m.includes("PICT"))).toBeTrue();
    });
});
