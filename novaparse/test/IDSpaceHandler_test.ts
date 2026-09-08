import "jasmine";
import { IDSpaceHandler } from "../src/IDSpaceHandler";
import { NovaResources } from "../src/resource_parsers/ResourceHolderBase";
import { fixturePath } from "../../test/fixture_path";


describe("IDSpaceHandler", function() {
    let idSpace: NovaResources;
    beforeEach(async function() {
        const dataPath = fixturePath("novaparse/test/IDSpaceHandlerTestFilesystem");
        const handler = new IDSpaceHandler(dataPath);
        idSpace = await handler.getIDSpace();
    });

    it("should properly handle overwriting of data by plug-ins", function() {
        //debugger;
        //console.log(idSpace);
        expect(idSpace.wëap['nova:128'].name).toEqual("Overwrites nova files");
        expect(idSpace.wëap['plug pack:153'].name).toEqual("Overwritten by pp2");
        expect(idSpace.wëap['nova:129'].name).toEqual("Overwritten by plugin2");

        expect(idSpace.wëap['Plugin 1:150'].name).toEqual("Also doesn\'t get overwritten");
        expect(idSpace.wëap['A first plug:150'].name).toEqual("this one also not overwritten");
    });

    it("should assign the right global id to each resource", function() {
        expect(idSpace.wëap['nova:128'].globalID).toEqual("nova:128");
        expect(idSpace.wëap['nova:129'].globalID).toEqual("nova:129");
        expect(idSpace.wëap['A first plug:150'].globalID).toEqual("A first plug:150");
        expect(idSpace.wëap['Plugin 1:150'].globalID).toEqual("Plugin 1:150");
        expect(idSpace.wëap['plug pack:153'].globalID).toEqual("plug pack:153");
    });

    it("resolves qualified keys directly and enumerates real resources", function() {
        const local = idSpace.wëap['Plugin 1:150'].idSpace.wëap;
        for (const key of Object.keys(idSpace.wëap)) {
            expect(local[key] === idSpace.wëap[key]).toBeTrue();
        }
        expect(Object.values(local).map(resource => resource.globalID))
            .toEqual(Object.values(idSpace.wëap).map(resource => resource.globalID));
        expect(local['missing:150']).toBeUndefined();
        expect(local['nova:150']).toBeUndefined();
    });

    it("preserves nova precedence and plug-in-local numeric resolution", function() {
        const plugin = idSpace.wëap['Plugin 1:150'].idSpace.wëap;
        const other = idSpace.wëap['A first plug:150'].idSpace.wëap;
        expect(plugin[128].globalID).toBe('nova:128');
        expect(plugin[129].globalID).toBe('nova:129');
        expect(plugin[150].globalID).toBe('Plugin 1:150');
        expect(other[150].globalID).toBe('A first plug:150');
        expect(plugin['A first plug:150'] === other[150]).toBeTrue();
        expect(plugin[153]).toBeUndefined();
    });

    /*
    it("Should assign the same pictID to ships with the same baseImage", function() {
        expect(idSpace.resources.shïp["nova:128"].pictID).toEqual(5000);
        expect(idSpace.resources.shïp["nova:129"].pictID).toEqual(5000);
        expect(idSpace.resources.shïp["nova:130"].pictID).toEqual(5002);
    });
    */

    it("should defer errors to when a specific idSpace is requested", async function() {
        const broken = new IDSpaceHandler("./not/a/real/path/");
        const brokenSpace = broken.getIDSpace("nova");
        await expectAsync(brokenSpace).toBeRejected();
    });
});
