import { BaseData } from "novadatainterface/BaseData";
import { BaseResource } from "../resource_parsers/NovaResourceBase";
import { displayName } from "./displayName";


export async function BaseParse(resource: BaseResource, _notFoundFunction: (message: string) => void): Promise<BaseData> {
    if (typeof resource === "undefined") {
        // Why can't I make the typechecker do this?
        throw new Error("Resource was undefined");
    }

    // These must have been set (by IDSpaceHandler::getIDSpaceUnsafe) when this function is called.
    if (resource.globalID == null) {
        throw new Error("Resource id was not set");
    }
    if (resource.prefix == null) {
        throw new Error("Resource prefix was not set");
    }

    return {
        id: resource.globalID,
        name: displayName(resource.name),
        prefix: resource.prefix
    };
}
