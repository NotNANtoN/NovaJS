import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { DescResource } from "../../src/resource_parsers/desc_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { resolveFixture } from "../../test/fixtures.js";
import { ResourceBuilder } from "./resource_builder.js";

describe("DescResource", () => {
    let d1: DescResource;
    let d2: DescResource;
    let rf: ResourceMap;

    // Descs don't depend on other resources.
    const idSpace = defaultIDSpace;

    beforeEach(async () => {
        const dataPath = resolveFixture("resource_examples/desc.ndat");
        rf = await readResourceFork(dataPath, false);

        const descs = rf.dësc;
        d1 = new DescResource(descs[128], idSpace);
        d2 = new DescResource(descs[129], idSpace);

    });

    it("Should parse the string in the desc", () => {
        expect(d1.text).toEqual("The first description has one line of text that you can read.");
        expect(d2.text).toEqual("This one has a graphic.");
    });

    it("Should parse graphic", () => {
        expect(d2.graphic).toEqual(4214);
    });

    it("defaults the trailing fields when truncated after the text", () => {
        // A dësc holding only its text (truncated right after the null
        // terminator) leaves the Graphic/MovieFile/Flags fields at defaults.
        const b = new ResourceBuilder();
        for (const ch of "Just text") {
            b.uint8(ch.charCodeAt(0));
        }
        b.uint8(0);     // null terminator; no trailing fields follow
        const d = new DescResource(b.resource("dësc", 201), idSpace);
        expect(d.text).toEqual("Just text");
        expect(d.graphic).toEqual(-1);
        expect(d.movieFile).toEqual("");
        expect(d.flags).toEqual(0);
    });

    it("parses the fixed trailing fields after a variable-length string", () => {
        // The Description string is variable length, so the trailing fields
        // start immediately after its null terminator.
        const b = new ResourceBuilder();
        for (const ch of "Hello") {
            b.uint8(ch.charCodeAt(0));
        }
        b.uint8(0)                  // null terminator ending the CSTR
            .int16(9000)            // Graphic (PICT id)
            .string("intro.mov", 0x20)  // Movie Filename
            .uint16(0x0005);        // Flags
        const d = new DescResource(b.resource("dësc", 200), idSpace);
        expect(d.text).toEqual("Hello");
        expect(d.graphic).toEqual(9000);
        expect(d.movieFile).toEqual("intro.mov");
        expect(d.flags).toEqual(0x0005);
    });
});
