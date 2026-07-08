import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * A jünk: a specialized tradeable commodity that can be bought and sold at a
 * few specific stellar objects.
 *
 * Field layout follows ResForge's jünk template (676 bytes), documented in
 * the EVN Bible p. 31.
 */
class JunkResource extends BaseResource {
    /**
     * 'spöb' ids where this commodity is sold (bought by the player at a low
     * price). Up to eight; unused entries omitted.
     */
    soldAt: number[];
    /**
     * 'spöb' ids where this commodity is bought (sold by the player at a high
     * price). Up to eight; unused entries omitted.
     */
    boughtAt: number[];
    /** Average price of the commodity. */
    basePrice: number;

    flags: number;
    /** Tribbles flag: the commodity multiplies in the cargo hold. */
    multiplies: boolean;
    /** Perishable: the commodity gradually decays in the cargo hold. */
    decays: boolean;

    /**
     * If this is an "illegal" cargo type, matched against a govt's ScanMask:
     * any shared 1 bit makes that government consider the cargo illegal.
     */
    scanMask: number;
    /** Lower-case name shown in the player-info dialog, e.g. "machine parts". */
    lcName: string;
    /** Short abbreviation shown in the status bar, e.g. "Parts". */
    abbrev: string;
    /** NCB test expression; the jünk is buyable only when this is true. */
    buyOn: string;
    /** NCB test expression; the jünk is sellable only when this is true. */
    sellOn: string;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        // Two parallel arrays of eight stellar ids each; drop unused (< 128).
        const usedStellars = (ids: number[]) => ids.filter(id => id >= 128);
        this.soldAt = usedStellars(r.array(8, () => r.int16(-1)));
        this.boughtAt = usedStellars(r.array(8, () => r.int16(-1)));

        this.basePrice = r.int16();

        this.flags = r.uint16();
        this.multiplies = Boolean(this.flags & 0x0001);
        this.decays = Boolean(this.flags & 0x0002);

        this.scanMask = r.uint16();
        this.lcName = r.string(0x40);
        this.abbrev = r.string(0x40);
        this.buyOn = r.string(0xff);
        this.sellOn = r.string(0xff);
    }
}

export { JunkResource };
