import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/** One escort ship class in a fleet, with min/max counts. */
type FleetEscort = {
    /** 'shïp' resource id of the escort's ship class. */
    id: number,
    /** Minimum number of this escort to include. */
    min: number,
    /** Maximum number of this escort to include. */
    max: number,
};

/**
 * A fleet: a collection of ships (a flagship plus escorts) made to appear
 * randomly throughout the galaxy.
 *
 * Field layout follows ResForge's flët template (306 bytes), documented in
 * the EVN Bible p. 26.
 */
class FletResource extends BaseResource {
    /** 'shïp' resource id of the fleet's flagship. */
    leadShip: number;
    /** Up to four escort ship classes with min/max counts; unused omitted. */
    escorts: Array<FleetEscort>;
    /** Government of the fleet; -1 for none. */
    govt: number;
    /**
     * Which systems the fleet can be created in: -1 any system; 128-2175 a
     * specific system; 10000-10255 this govt's systems; 15000-15255 an ally's;
     * 20000-20255 any but this govt's; 25000-25255 an enemy's.
     */
    linkSyst: number;
    /** NCB test expression; the fleet appears only when it evaluates true. */
    appearOn: string;
    /** STR# resource id for a random quote shown on hyperspace entry. */
    quote: number;

    flags: number;
    /** Freighters (inherent AI <= 2) in this fleet carry random cargo. */
    freightersRandomCargo: boolean;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.leadShip = r.int16(-1);

        // Parallel arrays: 4 escort ids (offset 2), 4 mins (offset 10), 4 maxes
        // (offset 18). Zip them, dropping unset ids (< 128 / -1).
        const ids = r.array(4, () => r.int16(-1));
        const mins = r.array(4, () => r.int16());
        const maxes = r.array(4, () => r.int16());
        this.escorts = [];
        for (let i = 0; i < 4; i++) {
            if (ids[i] >= 128) {
                this.escorts.push({ id: ids[i], min: mins[i], max: maxes[i] });
            }
        }

        this.govt = r.int16(-1);
        this.linkSyst = r.int16(-1);
        this.appearOn = r.string(0x100);
        this.quote = r.int16(-1);

        this.flags = r.uint16();
        this.freightersRandomCargo = Boolean(this.flags & 0x0001);
    }
}

export { FletResource };
