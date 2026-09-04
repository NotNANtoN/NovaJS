import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

export class RankResource extends BaseResource {
    readonly weight: number;
    readonly government: number;
    readonly salary: number;
    readonly salaryCap: number;
    readonly contribute: number[];
    readonly flags: number;
    readonly convName: string;
    readonly shortName: string;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const d = this.data;

        this.weight = d.getInt16(0);
        this.government = d.getInt16(2);
        this.salary = d.getInt32(4);
        this.salaryCap = d.getInt32(8);
        this.contribute = [
            d.byteLength >= 16 ? d.getUint32(12) : 0,
            d.byteLength >= 20 ? d.getUint32(16) : 0,
        ];
        this.flags = d.byteLength >= 24 ? d.getUint32(20) : 0;

        const getString = (start: number, length: number): string => {
            let s = "";
            for (let i = start; i < Math.min(start + length, d.byteLength); i++) {
                const val = d.getUint8(i);
                if (val === 0) break;
                s += String.fromCharCode(val);
            }
            return s;
        };

        this.convName = getString(24, 64);
        this.shortName = getString(88, 64);
    }
}
