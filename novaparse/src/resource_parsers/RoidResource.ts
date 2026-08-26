import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

const ASTEROID_SPIN_BASE = 800;

/**
 * Asteroids come in families of four sizes, and each family has one matching
 * "micro" sprite used for the ore it leaves behind: spïn 501 for the first
 * family, 502 for the next, and so on.
 */
const MINERAL_SPIN_BASE = 501;
const ASTEROID_FAMILY_SIZE = 4;

class RoidResource extends BaseResource {
    /** Hit points. */
    strength: number;
    /** Relative likelihood of this type being chosen when populating a belt. */
    prevalence: number;
    /**
     * Cargo released when destroyed. Values 0-5 are the standard commodities,
     * 1000 and above select a jünk resource, and -1 means the asteroid yields
     * nothing.
     */
    yieldType: number;
    yieldQuantity: number;
    /** Particle colour, stored as a 32 bit RGB value. */
    color: number;
    /** röid ids this breaks into, or -1. */
    fragmentTypes: [number, number];
    fragmentCount: number;
    /** 0 for small through 2 for huge. */
    sizeClass: number;
    mass: number;
    spinID: number;
    mineralSpinID: number;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const d = this.data;

        this.strength = d.getInt16(0);
        this.prevalence = d.getInt16(2);
        this.yieldType = d.getInt16(4);
        this.yieldQuantity = d.getInt16(6);
        this.color = d.getUint32(10) & 0xffffff;
        this.fragmentTypes = [d.getInt16(14), d.getInt16(16)];
        this.fragmentCount = d.getInt16(18);
        this.sizeClass = d.getInt16(20);
        this.mass = d.getInt16(22);
        // The resource carries no graphic reference: retail assigns artwork by
        // position, so röid 128 uses spïn 800 and so on.
        const index = this.id - 128;
        this.spinID = ASTEROID_SPIN_BASE + index;
        this.mineralSpinID = MINERAL_SPIN_BASE
            + Math.floor(index / ASTEROID_FAMILY_SIZE);
    }
}

export { RoidResource };
