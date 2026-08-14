import "jasmine";
import { StringTableParse } from "../../src/parsers/string_table_parse.js";
import { getEmptyNovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { StrNResource } from "../../src/resource_parsers/strn_resource.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/** A STR# resource: a uint16 count followed by that many Pascal strings. */
function buildStrN(strings: string[]): ResourceBuilder {
    const b = new ResourceBuilder();
    b.uint16(strings.length);
    for (const s of strings) {
        b.pstring(s);
    }
    return b;
}

function parseStrN(strings: string[], name = "Ship Names") {
    const resource = new StrNResource(
        buildStrN(strings).resource("STR#", 128, name),
        getEmptyNovaResources());
    // IDSpaceHandler sets these in the real pipeline; BaseParse requires them.
    resource.globalID = "nova:128";
    resource.prefix = "nova";
    return StringTableParse(resource, () => { });
}

describe("StringTableParse", () => {
    it("carries the BaseData fields", async () => {
        const data = await parseStrN(["a"]);
        expect(data.id).toBe("nova:128");
        expect(data.name).toBe("Ship Names");
        expect(data.prefix).toBe("nova");
    });

    it("round-trips the strings in list order", async () => {
        const data = await parseStrN(["Shuttle", "Freighter", "Viper"]);
        expect(data.strings).toEqual(["Shuttle", "Freighter", "Viper"]);
    });

    it("preserves empty strings so list positions stay aligned", async () => {
        // Real STR#s have holes; dropping them would shift every later index.
        const data = await parseStrN(["first", "", "", "fourth"]);
        expect(data.strings).toEqual(["first", "", "", "fourth"]);
        expect(data.strings.length).toBe(4);
        expect(data.strings[3]).toBe("fourth");
    });

    it("parses an empty list", async () => {
        const data = await parseStrN([]);
        expect(data.strings).toEqual([]);
    });
});
