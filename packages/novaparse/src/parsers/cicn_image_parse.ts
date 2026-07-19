import { CicnImageData } from "novadatainterface/cicn_image";
import { PNG } from "pngjs";
import { CicnResource } from "../resource_parsers/cicn_resource.js";
import { bufferToArrayBuffer } from "./buffer_to_array_buffer.js";

/** Renders a cicn colour icon as an RGBA PNG (alpha from the icon's mask). */
export async function CicnImageParse(cicn: CicnResource,
    _notFoundFunction: (m: string) => void): Promise<CicnImageData> {
    const png = new PNG({ width: cicn.width, height: cicn.height });
    png.data = Buffer.from(cicn.pixels.buffer, cicn.pixels.byteOffset,
        cicn.pixels.byteLength);
    return bufferToArrayBuffer(PNG.sync.write(png));
}
