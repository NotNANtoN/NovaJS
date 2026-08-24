import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

class DudeResource extends BaseResource {
    aiType: number;
    government: number;
    flags: number;
    infoTypes: number;
    shipTypes: number[];
    probabilities: number[];

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        var d = this.data;

        // The düde resource is 88 bytes: four header words followed by
        // sixteen ship types and sixteen matching probabilities.
        this.aiType = d.getInt16(0);
        this.government = d.getInt16(2);
        this.flags = d.getUint16(4);
        this.infoTypes = d.getUint16(6);
        this.shipTypes = [];
        this.probabilities = [];
        for (var i = 0; i < 16; i++) {
            this.shipTypes.push(d.getInt16(8 + i * 2));
            this.probabilities.push(d.getInt16(40 + i * 2));
        }
    }
}

export { DudeResource }
