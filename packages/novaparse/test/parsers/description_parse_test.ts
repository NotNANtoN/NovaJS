import "jasmine";
import { DescriptionParse } from "../../src/parsers/description_parse.js";
import { DescResource } from "../../src/resource_parsers/desc_resource.js";
import { getEmptyNovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/**
 * A dësc resource: a null-terminated Description string, then Graphic
 * (int16), Movie Filename (C020) and Flags (uint16).
 */
function buildDesc(text: string, graphic = -1): ResourceBuilder {
    const b = new ResourceBuilder();
    // string() writes the text plus zero padding, so a field one byte longer
    // than the text is exactly "text + null terminator".
    b.string(text, text.length + 1)
        .int16(graphic)
        .string("", 0x20)
        .uint16(0);
    return b;
}

function parseDesc(text: string, graphic = -1, name = "Description") {
    const resource = new DescResource(
        buildDesc(text, graphic).resource("dësc", 128, name),
        getEmptyNovaResources());
    // IDSpaceHandler sets these in the real pipeline; BaseParse requires them.
    resource.globalID = "nova:128";
    resource.prefix = "nova";
    return DescriptionParse(resource, () => { });
}

describe("DescriptionParse", () => {
    it("carries the BaseData fields", async () => {
        const data = await parseDesc("Some text");
        expect(data.id).toBe("nova:128");
        expect(data.name).toBe("Description");
        expect(data.prefix).toBe("nova");
    });

    it("passes plain text through unchanged", async () => {
        const data = await parseDesc("The bar is crowded tonight.");
        expect(data.text).toBe("The bar is crowded tonight.");
    });

    it("normalizes classic-Mac CR line endings to LF", async () => {
        // dësc text is stored with bare CRs; nothing downstream treats those
        // as line breaks, so the parser must convert them.
        const data = await parseDesc("first\rsecond\rthird");
        expect(data.text).toBe("first\nsecond\nthird");
        expect(data.text).not.toContain("\r");
    });

    it("normalizes CRLF line endings to a single LF", async () => {
        const data = await parseDesc("first\r\nsecond");
        expect(data.text).toBe("first\nsecond");
    });

    it("collapses neither blank lines nor existing LFs", async () => {
        const data = await parseDesc("para one\r\rpara two\nalready lf");
        expect(data.text).toBe("para one\n\npara two\nalready lf");
    });

    it("carries the graphic PICT id", async () => {
        const data = await parseDesc("text", 8000);
        expect(data.graphic).toBe(8000);
    });

    it("defaults the graphic to -1 when the resource is truncated", async () => {
        // Most real dëscs stop right after their text.
        const text = "Just text";
        const truncated = new ResourceBuilder()
            .string(text, text.length + 1);
        const resource = new DescResource(
            truncated.resource("dësc", 128, "Truncated"),
            getEmptyNovaResources());
        resource.globalID = "nova:128";
        resource.prefix = "nova";
        const data = await DescriptionParse(resource, () => { });
        expect(data.text).toBe(text);
        expect(data.graphic).toBe(-1);
    });
});
