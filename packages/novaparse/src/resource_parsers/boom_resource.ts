import { Resource } from "resource_fork";
import { NovaResources } from "./resource_holder_base.js";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";

/**
 * A bööm (explosion) resource.
 *
 * Field layout follows ResForge's bööm template (6 bytes, matching Nova's
 * own data exactly), documented in the EVN Bible p. 17. bööm ids 128-191
 * customize the 64 explosion types; graphics come from spïn 400-463 and
 * sounds from 'snd ' 300-363.
 */
class BoomResource extends BaseResource {
    /** Animation speed; 100 = 30 frames per second. */
    animationRate: number;
    /** 'snd ' resource id (index 0-63 mapped to 300+); null = silent. */
    sound: number | null;
    /** spïn resource id (index 0-63 mapped to 400+) of the explosion graphic. */
    graphic: number;
    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.animationRate = r.int16();

        const soundIndex = r.int16(-1);
        this.sound = soundIndex === -1 ? null : soundIndex + 300;

        const graphicIndex = r.int16(-1);
        if (graphicIndex === -1) {
            throw new Error("Boom id " + this.id + " had no graphic");
        }
        this.graphic = graphicIndex + 400;
    }
}

export { BoomResource }
