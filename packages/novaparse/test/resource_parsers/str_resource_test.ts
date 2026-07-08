import "jasmine";
import { StrResource } from "../../src/resource_parsers/str_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

describe("StrResource", () => {
    // STR resources don't depend on other resources.
    const idSpace = defaultIDSpace;

    it("parses a single Pascal string", () => {
        const b = new ResourceBuilder().pstring("Hello, pilot");
        const str = new StrResource(
            b.resource("STR ", 128, "Greeting"), idSpace);
        expect(str.string).toBe("Hello, pilot");
    });

    it("parses an empty string", () => {
        const b = new ResourceBuilder().pstring("");
        const str = new StrResource(
            b.resource("STR ", 129, "Empty"), idSpace);
        expect(str.string).toBe("");
    });

    it("ignores trailing data after the Pascal string", () => {
        // Many real STR resources append a C-string copy and padding; only
        // the leading Pascal string is meaningful.
        const b = new ResourceBuilder()
            .pstring("Landed")
            .string("Landed", 8)   // trailing garbage the parser must ignore
            .uint32(0xdeadbeef);
        const str = new StrResource(
            b.resource("STR ", 130, "Trailing"), idSpace);
        expect(str.string).toBe("Landed");
    });

    it("defaults to an empty string for an empty resource", () => {
        const b = new ResourceBuilder();
        const str = new StrResource(
            b.resource("STR ", 131, "Nothing"), idSpace);
        expect(str.string).toBe("");
    });
});
