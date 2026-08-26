import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

/**
 * Base PICT ID of the first nebula's artwork, and the stride between the
 * artwork sets of consecutive nëbu resources. Retail reserves seven PICT IDs
 * per nebula and uses the first three for the 25%, 50% and 100% zoom levels.
 */
const NEBULA_PICT_BASE = 9500;
const NEBULA_PICT_STRIDE = 7;

class NebuResource extends BaseResource {
    /** Position and size on the galaxy map. */
    xPos: number;
    yPos: number;
    width: number;
    height: number;
    /** Artwork for the map's three zoom levels. */
    pictIDs: [number, number, number];

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const d = this.data;

        // The retail resource is 534 bytes, but only the leading four int16
        // fields are used; the remainder is reserved and stored as zeroes.
        this.xPos = d.getInt16(0);
        this.yPos = d.getInt16(2);
        this.width = d.getInt16(4);
        this.height = d.getInt16(6);

        const base = NEBULA_PICT_BASE + (this.id - 128) * NEBULA_PICT_STRIDE;
        this.pictIDs = [base, base + 1, base + 2];
    }
}

export { NebuResource };
