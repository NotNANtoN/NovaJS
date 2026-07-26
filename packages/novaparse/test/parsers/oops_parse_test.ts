import "jasmine";
import { OopsResource } from "../../src/resource_parsers/oops_resource.js";
import { OopsParse } from "../../src/parsers/oops_parse.js";
import { SpobResource } from "../../src/resource_parsers/spob_resource.js";
import { getEmptyNovaResources, NovaResources }
    from "../../src/resource_parsers/resource_holder_base.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/** A minimal spöb registered so stellar-id resolution can find it. */
function registerSpob(idSpace: NovaResources, localId: number,
    globalID: string) {
    const b = new ResourceBuilder();
    // Just enough bytes for SpobResource to parse without throwing; the
    // parse function only reads globalID.
    b.skip(0x100);
    const spob = new SpobResource(b.resource("spöb", localId), idSpace);
    spob.globalID = globalID;
    spob.prefix = "nova";
    idSpace.spöb[localId] = spob;
}

function buildOops(stellar: number): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(stellar)                            // stellar
        .int16(2)                               // commodity (medical)
        .int16(-50)                             // priceDelta
        .int16(14)                              // duration
        .int16(25)                              // freq
        .string("b200 !b201", 0x100)            // activateOn
        .skip(0x10);
    return b;
}

function parseOops(idSpace: NovaResources, stellar: number, id = 128) {
    const resource = new OopsResource(
        buildOops(stellar).resource("öops", id, "Test Disaster"), idSpace);
    resource.globalID = `nova:${id}`;
    resource.prefix = "nova";
    return OopsParse(resource, () => { });
}

describe("OopsParse", () => {
    let idSpace: NovaResources;

    beforeEach(() => {
        idSpace = getEmptyNovaResources();
        registerSpob(idSpace, 137, "nova:137");
    });

    it("carries the BaseData and scalar fields", async () => {
        const oops = await parseOops(idSpace, 137);
        expect(oops.id).toBe("nova:128");
        expect(oops.name).toBe("Test Disaster");
        expect(oops.commodity).toBe(2);
        expect(oops.priceDelta).toBe(-50);
        expect(oops.duration).toBe(14);
        expect(oops.freq).toBe(25);
        expect(oops.activateOn).toBe("b200 !b201");
    });

    it("resolves a stellar local id to its global id", async () => {
        const oops = await parseOops(idSpace, 137);
        expect(oops.stellar).toBe("nova:137");
        expect(oops.appliesToAll).toBe(false);
    });

    it("marks Stellar = -1 as applying to all planets", async () => {
        const oops = await parseOops(idSpace, -1);
        expect(oops.appliesToAll).toBe(true);
        expect(oops.stellar).toBeNull();
    });

    it("resolves Stellar = -2 (news-only) to no stellar", async () => {
        const oops = await parseOops(idSpace, -2);
        expect(oops.appliesToAll).toBe(false);
        expect(oops.stellar).toBeNull();
    });

    it("reports a missing stellar and leaves it unresolved", async () => {
        let reported = "";
        const resource = new OopsResource(
            buildOops(999).resource("öops", 128, "Test Disaster"), idSpace);
        resource.globalID = "nova:128";
        resource.prefix = "nova";
        const oops = await OopsParse(resource, m => { reported = m; });
        expect(oops.stellar).toBeNull();
        expect(reported).toContain("999");
    });
});
