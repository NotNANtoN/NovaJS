import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

export class OopsResource extends BaseResource {
    readonly stellar: number;
    readonly commodity: number;
    readonly priceDelta: number;
    readonly duration: number;
    readonly freq: number;
    readonly activateOn: string;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const d = this.data;

        this.stellar = d.getInt16(0);
        this.commodity = d.getInt16(2);
        this.priceDelta = d.getInt16(4);
        this.duration = d.getInt16(6);
        this.freq = d.getInt16(8);

        let s = "";
        for (let i = 10; i < Math.min(282, d.byteLength); i++) {
            const val = d.getUint8(i);
            if (val === 0) break;
            s += String.fromCharCode(val);
        }
        this.activateOn = s;
    }
}
