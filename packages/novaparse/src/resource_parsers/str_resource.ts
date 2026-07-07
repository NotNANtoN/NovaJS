import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * A single string (STR , with a trailing space in the four-character type).
 *
 * The standard Mac 'STR ' resource format: a single Pascal string, optionally
 * followed by extra data (a C string copy and/or arbitrary payload) that this
 * parser ignores. Nova's own data files contain no STR resources, but
 * plug-ins use them, so this is exercised by unit tests only.
 */
class StrResource extends BaseResource {
    /** The Pascal string stored at the start of the resource. */
    string: string;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.string = r.pstring();
    }
}

export { StrResource };
