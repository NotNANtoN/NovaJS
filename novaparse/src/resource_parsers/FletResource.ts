import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

/**
 * CFletResource stores 15 meaningful words followed by a 256-byte
 * null-terminated expression. Retail records are 306 bytes: the final 16
 * bytes are zero padding after Flags.
 *
 * The offsets below are intentionally kept beside the parser. They are
 * verified against every retail flët record, rather than inferred from the
 * similarly shaped düde resource.
 */
export const FLET_APPEAR_ON_BYTES = 256;
export const FLET_MEANINGFUL_BYTES = 290;

class FletResource extends BaseResource {
    leadShipType: number;
    escortTypes: number[];
    minEscorts: number[];
    maxEscorts: number[];
    government: number;
    linkSyst: number;
    appearOn: string;
    quote: number;
    flags: number;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        var d = this.data;

        // EV Nova Bible, "The flët resource": LeadShipType, EscortType x4,
        // Min x4, Max x4, Govt, LinkSyst, AppearOn, Quote, and Flags.
        this.leadShipType = d.getInt16(0);
        this.escortTypes = [];
        this.minEscorts = [];
        this.maxEscorts = [];
        for (var i = 0; i < 4; i++) {
            this.escortTypes.push(d.getInt16(2 + i * 2));
            this.minEscorts.push(d.getInt16(10 + i * 2));
            this.maxEscorts.push(d.getInt16(18 + i * 2));
        }
        this.government = d.getInt16(26);
        this.linkSyst = d.getInt16(28);
        this.appearOn = "";
        for (var j = 0; j < FLET_APPEAR_ON_BYTES; j++) {
            var c = d.getUint8(30 + j);
            if (c === 0) {
                break;
            }
            this.appearOn += String.fromCharCode(c);
        }
        this.quote = d.getInt16(286);
        this.flags = d.getUint16(288);
    }
}

export { FletResource }
