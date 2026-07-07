import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * A string list (STR#, referred to as STRH in the codebase where a bare '#'
 * isn't a valid identifier character).
 *
 * The standard Mac 'STR#' resource format: a uint16 count followed by that
 * many Pascal strings back to back. Nova uses these for ship names, hail and
 * comm quotes, cargo types, stellar type descriptions, and similar
 * user-visible text that other resources index into by list position.
 */
class StrNResource extends BaseResource {
    /** The strings in list order; index 0 is the resource's "first string". */
    strings: string[];

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        const count = r.uint16();
        this.strings = r.array(count, () => r.pstring());
    }
}

export { StrNResource };
