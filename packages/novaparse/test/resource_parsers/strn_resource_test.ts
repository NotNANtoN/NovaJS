import "jasmine";
import { StrNResource } from "../../src/resource_parsers/strn_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A STR# resource holding three recognizable strings. */
function buildStrN(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.uint16(3)                     // count
        .pstring("Kestrel")         // strings[0]
        .pstring("Leviathan")       // strings[1]
        .pstring("Rebel Destroyer"); // strings[2]
    return b;
}

describe("StrNResource", () => {
    // STR# lists don't depend on other resources.
    const idSpace = defaultIDSpace;

    let strn: StrNResource;

    beforeEach(() => {
        strn = new StrNResource(
            buildStrN().resource("STR#", 128, "Ship Names"), idSpace);
    });

    it("builds a resource of the expected size", () => {
        // uint16 count + (1+7) + (1+9) + (1+15) = 2 + 8 + 10 + 16 = 36 bytes.
        expect(buildStrN().byteLength).toBe(36);
    });

    it("parses all strings in list order", () => {
        expect(strn.strings).toEqual(
            ["Kestrel", "Leviathan", "Rebel Destroyer"]);
    });

    it("parses an empty list", () => {
        const empty = new ResourceBuilder().uint16(0);
        const parsed = new StrNResource(
            empty.resource("STR#", 129, "Empty"), idSpace);
        expect(parsed.strings).toEqual([]);
    });

    it("preserves empty strings within the list", () => {
        const b = new ResourceBuilder()
            .uint16(3)
            .pstring("first")
            .pstring("")
            .pstring("third");
        const parsed = new StrNResource(
            b.resource("STR#", 130, "Gappy"), idSpace);
        expect(parsed.strings).toEqual(["first", "", "third"]);
    });

    it("stops cleanly when a truncated resource ends mid-list", () => {
        // Claim four strings but only supply the first two.
        const b = new ResourceBuilder()
            .uint16(4)
            .pstring("one")
            .pstring("two");
        const parsed = new StrNResource(
            b.resource("STR#", 131, "Truncated"), idSpace);
        // The two present strings parse; the missing ones read as "".
        expect(parsed.strings).toEqual(["one", "two", "", ""]);
    });
});
