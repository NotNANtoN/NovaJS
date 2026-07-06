import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * A nëbu: a nebula (or other background phenomenon) drawn behind the star
 * map. Purely decorative, though its OnExplore field can trigger events.
 *
 * Field layout follows ResForge's nëbu template (534 bytes), documented in
 * the EVN Bible p. 41. Position and size are in the scale of the 'normal'
 * (unzoomed) map, relative to the image's upper-left corner.
 */
class NebuResource extends BaseResource {
    /** Image x position on the star map, at normal zoom. */
    xPos: number;
    /** Image y position on the star map, at normal zoom. */
    yPos: number;
    /** Image width on the star map, at normal zoom. */
    xSize: number;
    /** Image height on the star map, at normal zoom. */
    ySize: number;
    /** NCB test expression gating whether the nebula is visible. */
    activeOn: string;
    /** NCB set expression run whenever the nebula is tested and found visible. */
    onExplore: string;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.xPos = r.int16();
        this.yPos = r.int16();
        this.xSize = r.int16();
        this.ySize = r.int16();
        this.activeOn = r.string(0xff);
        this.onExplore = r.string(0xff);
        r.skip(0x10); // Unused padding.
    }
}

export { NebuResource };
