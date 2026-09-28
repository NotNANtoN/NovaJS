import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

/**
 * EV Nova Bible, ränk resource (verified against retail data):
 * Weight i16@0, AttachTo i16@2, PriceMod i16@4, Salary i32@6,
 * SalaryCap i32@10, Contribute [u32@14, u32@18], Flags u16@22,
 * ConvName string@24 (64), ShortName string@88 (64).
 * PriceMod is kept raw: retail uses 0 on ranks with no price modifier.
 */
export class RankResource extends BaseResource {
    readonly weight: number;
    readonly government: number;
    readonly priceMod: number;
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
        this.priceMod = d.getInt16(4);
        this.salary = d.getInt32(6);
        this.salaryCap = d.getInt32(10);
        this.contribute = [d.getUint32(14), d.getUint32(18)];
        this.flags = d.getUint16(22);

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
