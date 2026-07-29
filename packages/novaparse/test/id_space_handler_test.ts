import "jasmine";
import { IDSpaceHandler } from "../src/id_space_handler.js";
import { NovaParse } from "../src/nova_parse.js";
import { NovaResources } from "../src/resource_parsers/resource_holder_base.js";
import { resolveFixture } from "./fixtures.js";


describe("IDSpaceHandler", () => {
    let idSpace: NovaResources;
    beforeEach(async () => {
        const dataPath = resolveFixture("IDSpaceHandlerTestFilesystem");
        const handler = new IDSpaceHandler(dataPath);
        idSpace = await handler.getIDSpace();
    });

    it("should properly handle overwriting of data by plug-ins", () => {
        //debugger;
        //console.log(idSpace);
        expect(idSpace.wëap['nova:128'].name).toEqual("Overwrites nova files");
        expect(idSpace.wëap['plug pack:153'].name).toEqual("Overwritten by pp2");
        expect(idSpace.wëap['nova:129'].name).toEqual("Overwritten by plugin2");

        expect(idSpace.wëap['Plugin 1:150'].name).toEqual("Also doesn\'t get overwritten");
        expect(idSpace.wëap['A first plug:150'].name).toEqual("this one also not overwritten");
    });

    it("should assign the right global id to each resource", () => {
        expect(idSpace.wëap['nova:128'].globalID).toEqual("nova:128");
        expect(idSpace.wëap['nova:129'].globalID).toEqual("nova:129");
        expect(idSpace.wëap['A first plug:150'].globalID).toEqual("A first plug:150");
        expect(idSpace.wëap['Plugin 1:150'].globalID).toEqual("Plugin 1:150");
        expect(idSpace.wëap['plug pack:153'].globalID).toEqual("plug pack:153");
    });

    /*
    it("Should assign the same pictID to ships with the same baseImage", () => {
        expect(idSpace.resources.shïp["nova:128"].pictID).toEqual(5000);
        expect(idSpace.resources.shïp["nova:129"].pictID).toEqual(5000);
        expect(idSpace.resources.shïp["nova:130"].pictID).toEqual(5002);
    });
    */

    it("should defer errors to when a specific idSpace is requested", async () => {
        const broken = new IDSpaceHandler("./not/a/real/path/");
        const brokenSpace = broken.getIDSpace("nova");
        await expectAsync(brokenSpace).toBeRejected();
    });
});

// `novaPlugins: null` is the explicit opt-out used by the integration test
// fixture so that test results don't depend on which plug-ins a developer
// happens to have installed. It must load the base "Nova Files" data exactly
// as usual while skipping the Plug-ins directory entirely — including the
// plug-in overwrites of core ids.
describe("IDSpaceHandler with plug-in loading disabled", () => {
    const dataPath = resolveFixture("IDSpaceHandlerTestFilesystem");
    let noPlugins: NovaResources;

    beforeEach(async () => {
        noPlugins = await new IDSpaceHandler(dataPath,
            { novaFiles: "Nova Files", novaPlugins: null }).getIDSpace();
    });

    it("still loads the core Nova Files resources", () => {
        expect(noPlugins.wëap['nova:300'].name)
            .toEqual("will not be overwritten");
        expect(noPlugins.wëap['nova:300'].globalID).toEqual("nova:300");
    });

    it("omits every plug-in-namespaced resource", () => {
        expect(noPlugins.wëap['plug pack:150']).toBeUndefined();
        expect(noPlugins.wëap['plug pack:153']).toBeUndefined();
        expect(noPlugins.wëap['Plugin 1:150']).toBeUndefined();
        expect(noPlugins.wëap['A first plug:150']).toBeUndefined();

        // Nothing outside the "nova:" namespace survives at all.
        expect(Object.keys(noPlugins.wëap).sort())
            .toEqual(['nova:128', 'nova:129', 'nova:300']);
    });

    it("keeps the ORIGINAL core values that plug-ins would have overwritten",
        async () => {
            // With plug-ins these two read "Overwrites nova files" and
            // "Overwritten by plugin2" (see the suite above).
            expect(noPlugins.wëap['nova:128'].name)
                .toEqual("will be overwritten (source nova files)");
            expect(noPlugins.wëap['nova:129'].name)
                .toEqual("a weap to overwrite");

            const withPlugins = await new IDSpaceHandler(dataPath).getIDSpace();
            expect(withPlugins.wëap['nova:128'].name)
                .toEqual("Overwrites nova files");
        });

    it("does not change the default, which still loads plug-ins", async () => {
        const defaulted = await new IDSpaceHandler(dataPath).getIDSpace();
        expect(defaulted.wëap['Plugin 1:150'].name)
            .toEqual("Also doesn't get overwritten");
    });
});

describe("NovaParse with plug-in loading disabled", () => {
    const dataPath = resolveFixture("IDSpaceHandlerTestFilesystem");

    it("exposes only Nova Files ids", async () => {
        const noPlugins = new NovaParse(dataPath, false,
            { novaFiles: "Nova Files", novaPlugins: null });
        const ids = await noPlugins.ids;

        expect(ids.Weapon).toContain("nova:300");
        for (const id of ids.Weapon) {
            expect(id.startsWith("nova:")).toBeTrue();
        }
    });

    it("loads plug-in ids by default", async () => {
        const withPlugins = new NovaParse(dataPath, false);
        const ids = await withPlugins.ids;
        expect(ids.Weapon).toContain("Plugin 1:150");
    });
});
