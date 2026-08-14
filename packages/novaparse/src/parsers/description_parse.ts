import { BaseData } from "novadatainterface/base_data";
import { DescriptionData } from "novadatainterface/description_data";
import { DescResource } from "../resource_parsers/desc_resource.js";
import { BaseParse } from "./base_parse.js";

/**
 * dësc text is stored with classic-Mac line endings (a bare CR, 0x0D). Nothing
 * downstream — text measurement, wrapping, or a browser <div> — treats CR as a
 * line break, so a raw dësc renders as one giant run-on line. Normalize CRLF
 * and lone CR to LF here, once, so the rest of the game only ever sees "\n".
 */
function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

/**
 * Projects a parsed dësc resource onto DescriptionData.
 */
export async function DescriptionParse(desc: DescResource, notFoundFunction: (m: string) => void): Promise<DescriptionData> {
    const base: BaseData = await BaseParse(desc, notFoundFunction);

    return {
        ...base,
        text: normalizeLineEndings(desc.text),
        graphic: desc.graphic,
    };
}
