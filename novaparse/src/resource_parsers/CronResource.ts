import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

export class CronResource extends BaseResource {
    readonly firstDay: number;
    readonly firstMonth: number;
    readonly firstYear: number;
    readonly lastDay: number;
    readonly lastMonth: number;
    readonly lastYear: number;
    readonly random: number;
    readonly duration: number;
    readonly preHoldoff: number;
    readonly postHoldoff: number;
    readonly indNewsStr: number;
    readonly flags: number;
    readonly enableOn: string;
    readonly onStart: string;
    readonly onEnd: string;
    readonly contribute: number[];
    readonly require: number[];
    readonly newsGovt: number[];
    readonly govtNewsStr: number[];

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const d = this.data;

        this.firstDay = d.getInt16(0);
        this.firstMonth = d.getInt16(2);
        this.firstYear = d.getInt16(4);
        this.lastDay = d.getInt16(6);
        this.lastMonth = d.getInt16(8);
        this.lastYear = d.getInt16(10);
        this.random = d.getInt16(12);
        this.duration = d.getInt16(14);
        this.preHoldoff = d.getInt16(16);
        this.postHoldoff = d.getInt16(18);
        this.indNewsStr = d.getInt16(20);
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

        this.enableOn = getString(24, 255);
        this.onStart = getString(279, 255);
        this.onEnd = getString(534, 255);

        this.contribute = [
            d.byteLength >= 794 ? d.getUint32(790) : 0,
            d.byteLength >= 798 ? d.getUint32(794) : 0,
        ];
        this.require = [
            d.byteLength >= 802 ? d.getUint32(798) : 0,
            d.byteLength >= 806 ? d.getUint32(802) : 0,
        ];
        this.newsGovt = [
            d.byteLength >= 808 ? d.getInt16(806) : -1,
            d.byteLength >= 810 ? d.getInt16(808) : -1,
            d.byteLength >= 812 ? d.getInt16(810) : -1,
            d.byteLength >= 814 ? d.getInt16(812) : -1,
        ];
        this.govtNewsStr = [
            d.byteLength >= 816 ? d.getInt16(814) : -1,
            d.byteLength >= 818 ? d.getInt16(816) : -1,
            d.byteLength >= 820 ? d.getInt16(818) : -1,
            d.byteLength >= 822 ? d.getInt16(820) : -1,
        ];
    }
}
