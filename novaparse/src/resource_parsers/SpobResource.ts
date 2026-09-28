import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";
import {
    getTradeCommodities,
    TradeCommodity,
} from "novadatainterface/CommodityData";

class SpobResource extends BaseResource {
    position: number[];
    graphic: number;
    flags: number;
    tribute: number;
    techLevel: number;
    specialTech: number[];
    government: number;
    landingPictID: number;
    landingDescID: number;
    /** spöb CustSndID: ambient landscape sound, -1 for none. */
    ambientSoundID: number;
    tradeCommodities: TradeCommodity[];
    /** Control-bit set expressions (EV Nova Bible, spöb OnDominate etc.). */
    onDominate: string;
    onRelease: string;
    onDestroy: string;
    onRegen: string;
    /** Flags2 (e.g. 0x0040 "starts the game destroyed"). */
    flags2: number;
    /** Damage from planet-type weapons before destruction; <= 0 invincible. */
    strength: number;
    deadType: number;
    /** Days destroyed; 0 = regenerate at the end of the day, -1 = never. */
    deadTime: number;
    explodType: number;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        var d = resource.data;
        this.position = [d.getInt16(0), d.getInt16(2)];
        this.graphic = d.getInt16(4) + 2000;
        if (this.graphic > 2058) {
            this.graphic -= 1;
        }
        this.flags = d.getUint32(6);

        this.tribute = d.getInt16(10);
        this.techLevel = d.getInt16(12);
        this.specialTech = [
            d.getInt16(14),
            d.getInt16(16),
            d.getInt16(18)
        ];
        this.government = d.getInt16(20);
        // Signed: retail stores -1 for "no custom landing picture", which
        // read as unsigned becomes 65535 and then looks like a real resource
        // ID. Resource IDs never exceed 32767, so this is lossless.
        this.landingPictID = d.getInt16(24);
        this.ambientSoundID = d.getInt16(26);
        this.landingDescID = this.id;
        this.tradeCommodities = getTradeCommodities(this.flags);
        this.flags2 = d.getUint16(32);
        this.strength = d.byteLength >= 576 ? d.getInt32(572) : 0;
        this.deadType = d.byteLength >= 578 ? d.getInt16(576) : -1;
        this.deadTime = d.byteLength >= 580 ? d.getInt16(578) : -1;
        this.explodType = d.byteLength >= 582 ? d.getInt16(580) : -1;

        const getString = (start: number, length: number): string => {
            let s = "";
            for (let i = start; i < Math.min(start + length, d.byteLength); i++) {
                const value = d.getUint8(i);
                if (value === 0) break;
                s += String.fromCharCode(value);
            }
            return s;
        };
        this.onDominate = getString(54, 256);
        this.onRelease = getString(310, 256);
        this.onDestroy = getString(582, 256);
        this.onRegen = getString(838, 256);
    }

}



export { SpobResource }
