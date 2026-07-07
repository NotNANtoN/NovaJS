import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * An asteroid type. Nova supports up to 16 asteroid types, stored in röid
 * resources 128-143.
 *
 * Field layout follows ResForge's röid template (40 bytes), documented in the
 * EVN Bible p. 52.
 */
class RoidResource extends BaseResource {
    /** Strength, equivalent to a ship's armour value. */
    strength: number;
    /** Frame advance rate; 100 = 30 frames per second, lower is slower. */
    spinRate: number;
    /**
     * Cargo yielded by ejected resource-boxes: -1 none; 0-5 standard cargo
     * type; 1000+ a jünk resource.
     */
    yieldType: number;
    /** Average number of resource-boxes ejected when destroyed (+/- 50%). */
    yieldQuantity: number;
    /** Number of particles thrown off when destroyed. */
    particleCount: number;
    /** Particle colour, encoded as 00RRGGBB. */
    particleColor: number;
    /**
     * Up to two sub-asteroid types generated on destruction; -1 for none. If
     * both are set, Nova picks between them per sub-asteroid.
     */
    fragTypes: number[];
    /** Average number of sub-asteroids generated on destruction (+/- 50%). */
    fragCount: number;
    /**
     * Explosion shown on destruction: -1 none; 0-63 a bööm; add 1000 for an
     * explosion with sparks. Kept raw, matching the wëap ExplodeType encoding.
     */
    explodeType: number;
    /** Mass, used when weapons hit the asteroid. */
    mass: number;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.strength = r.int16();
        this.spinRate = r.int16();
        this.yieldType = r.int16(-1);
        this.yieldQuantity = r.int16();
        this.particleCount = r.int16();
        this.particleColor = r.uint32();
        this.fragTypes = r.array(2, () => r.int16(-1)).filter(id => id !== -1);
        this.fragCount = r.int16();
        this.explodeType = r.int16(-1);
        this.mass = r.int16();
    }
}

export { RoidResource };
