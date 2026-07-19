import "jasmine";
import { FletResource } from "../../src/resource_parsers/flet_resource.js";
import { FleetParse } from "../../src/parsers/fleet_parse.js";
import { getEmptyNovaResources, NovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/** An id space stubbed with just the globalIDs the parser resolves. */
function makeIdSpace(): NovaResources {
    const idSpace = getEmptyNovaResources();
    const stub = (globalID: string) => ({ globalID }) as never;
    idSpace.shïp[200] = stub("nova:200");
    idSpace.shïp[201] = stub("nova:201");
    idSpace.shïp[202] = stub("nova:202");
    idSpace.gövt[133] = stub("nova:133");
    idSpace.gövt[150] = stub("nova:150");
    idSpace.sÿst[400] = stub("nova:400");
    return idSpace;
}

function buildFlet(linkSyst: number): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(200)                                    // leadShip
        .array([201, 202, 202, -1], v => b.int16(v))    // escort ids
        .array([1, 0, 0, 0], v => b.int16(v))           // mins
        .array([3, 2, 0, 0], v => b.int16(v))           // maxes: 3rd is a
        // Bible-style "unused slot pointed at a valid ship" (max 0).
        .int16(150)                                 // govt
        .int16(linkSyst)                            // linkSyst
        .string("!b9999", 0x100)                    // appearOn
        .int16(7000)                                // quote
        .uint16(0x0001)                             // flags
        .skip(16);
    return b;
}

function parseFleet(linkSyst: number) {
    const resource = new FletResource(
        buildFlet(linkSyst).resource("flët", 128, "Test Fleet"),
        makeIdSpace());
    resource.globalID = "nova:128";
    resource.prefix = "nova";
    return FleetParse(resource, () => { });
}

describe("FleetParse", () => {
    it("resolves the lead ship and govt to global ids", async () => {
        const fleet = await parseFleet(-1);
        expect(fleet.leadShip).toBe("nova:200");
        expect(fleet.govt).toBe("nova:150");
    });

    it("keeps escorts with max > 0, resolved to global ids", async () => {
        const fleet = await parseFleet(-1);
        expect(fleet.escorts).toEqual([
            { id: "nova:201", min: 1, max: 3 },
            { id: "nova:202", min: 0, max: 2 },
            // The max=0 placeholder slot is dropped.
        ]);
    });

    it("carries the AppearOn expression", async () => {
        const fleet = await parseFleet(-1);
        expect(fleet.appearOn).toBe("!b9999");
    });

    it("parses LinkSyst -1 as any system", async () => {
        expect((await parseFleet(-1)).linkSyst).toEqual({ type: 'any' });
    });

    it("parses a specific-system LinkSyst to a global system id", async () => {
        expect((await parseFleet(400)).linkSyst)
            .toEqual({ type: 'system', id: 'nova:400' });
    });

    it("parses the govt-relative LinkSyst ranges", async () => {
        expect((await parseFleet(10005)).linkSyst)
            .toEqual({ type: 'govtSystems', govt: 'nova:133' });
        expect((await parseFleet(15005)).linkSyst)
            .toEqual({ type: 'allySystems', govt: 'nova:133' });
        expect((await parseFleet(20005)).linkSyst)
            .toEqual({ type: 'notGovtSystems', govt: 'nova:133' });
        expect((await parseFleet(25005)).linkSyst)
            .toEqual({ type: 'enemySystems', govt: 'nova:133' });
    });

    it("degrades an unresolvable LinkSyst reference to any", async () => {
        // gövt 128 + (10099 - 10000) = 227 is not in the id space.
        expect((await parseFleet(10099)).linkSyst).toEqual({ type: 'any' });
    });

    it("throws when the lead ship is missing", async () => {
        const idSpace = makeIdSpace();
        delete idSpace.shïp[200];
        const resource = new FletResource(
            buildFlet(-1).resource("flët", 128, "Broken Fleet"), idSpace);
        resource.globalID = "nova:128";
        resource.prefix = "nova";
        await expectAsync(FleetParse(resource, () => { })).toBeRejected();
    });
});
