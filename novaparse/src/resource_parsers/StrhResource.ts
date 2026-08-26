import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

/**
 * A classic `STR#` list: a count followed by that many Pascal strings, each a
 * length byte followed by its Mac Roman bytes. Nova keeps its user-visible
 * word lists here, including the legal-record and combat-rating ladders.
 */
class StrhResource extends BaseResource {
    strings: string[];

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const d = this.data;
        this.strings = [];
        if (d.byteLength < 2) {
            return;
        }
        const count = d.getUint16(0);
        let offset = 2;
        for (let index = 0; index < count; index++) {
            if (offset >= d.byteLength) {
                break;
            }
            const length = d.getUint8(offset);
            offset++;
            let text = "";
            for (let i = 0; i < length && offset + i < d.byteLength; i++) {
                text += String.fromCharCode(d.getUint8(offset + i));
            }
            offset += length;
            this.strings.push(text);
        }
    }
}

export { StrhResource };
