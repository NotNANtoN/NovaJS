import { PpatImageData } from "novadatainterface/ppat_image";
import { PNG } from "pngjs";
import { PpatResource } from "../resource_parsers/ppat_resource.js";
import { bufferToArrayBuffer } from "./buffer_to_array_buffer.js";

/** Renders a ppat pixel pattern as a PNG. */
export async function PpatImageParse(ppat: PpatResource,
    _notFoundFunction: (m: string) => void): Promise<PpatImageData> {
    const png = new PNG({ width: ppat.width, height: ppat.height });
    png.data = Buffer.from(ppat.pixels.buffer, ppat.pixels.byteOffset,
        ppat.pixels.byteLength);
    return bufferToArrayBuffer(PNG.sync.write(png));
}
