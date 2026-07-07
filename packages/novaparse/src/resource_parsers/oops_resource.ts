import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * An öops: a "planetary disaster" that temporarily changes the price of a
 * single commodity at a stellar object.
 *
 * Field layout follows ResForge's öops template (282 bytes), documented in
 * the EVN Bible p. 42.
 */
class OopsResource extends BaseResource {
    /**
     * 'spöb' id of the affected stellar object; -1 = any planet/station,
     * -2 = nothing (mission-related news only).
     */
    stellar: number;
    /**
     * Which commodity's price is affected: 0 food, 1 industrial, 2 medical,
     * 3 luxury, 4 metal, 5 equipment.
     */
    commodity: number;
    /** How much to change the price by; negative lowers it. */
    priceDelta: number;
    /** How many days the disaster lasts. */
    duration: number;
    /** Percent chance per day that the disaster occurs. */
    freq: number;
    /** NCB test expression gating whether the disaster can activate. */
    activateOn: string;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.stellar = r.int16(-1);
        this.commodity = r.int16();
        this.priceDelta = r.int16();
        this.duration = r.int16();
        this.freq = r.int16();
        this.activateOn = r.string(0x100);
        r.skip(0x10); // Unused padding.
    }
}

export { OopsResource };
