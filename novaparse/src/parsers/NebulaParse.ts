import { NebulaData } from "novadatainterface/NebulaData";
import { NebuResource } from "../resource_parsers/NebuResource";
import { BaseParse } from "./BaseParse";

export async function NebulaParse(
    nebu: NebuResource,
    notFoundFunction: (message: string) => void,
): Promise<NebulaData> {
    const base = await BaseParse(nebu, notFoundFunction);

    const [zoom25, zoom50, zoom100] = nebu.pictIDs.map(pictID => {
        const pict = nebu.idSpace.PICT[pictID];
        if (!pict) {
            // A nebula without artwork still contributes its name to the map,
            // so a missing PICT is reported but not fatal.
            notFoundFunction(
                `No matching PICT ${pictID} for nëbu of id ${base.id}`);
            return null;
        }
        return pict.globalID;
    });

    return {
        ...base,
        position: { x: nebu.xPos, y: nebu.yPos },
        size: { x: nebu.width, y: nebu.height },
        images: { zoom25, zoom50, zoom100 },
    };
}
