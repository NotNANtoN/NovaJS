import { BaseResource } from "./nova_resource_base.js";
import { NovaResources } from "./resource_holder_base.js";
import { Resource } from "resource_fork";
import { PICTParse } from "./pict_parse.js";
import { PNG } from "pngjs";

class PNGError extends Error { };

class PictResource extends BaseResource {
    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
    }

    get png(): PNG {
        var PICT: PICTParse;
        try {
            PICT = new PICTParse(this.data);
        }
        catch (e) {
            throw new PNGError("PICT id " + this.id + " failed to parse: " + e);
        }
        return PICT.PNG;
    }
}

export { PictResource, PNGError };

