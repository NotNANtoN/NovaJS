import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/** One ship class this dude can spawn, with its spawn probability. */
type DudeShip = {
    /** 'shïp' resource id. */
    id: number,
    /** Relative probability, in percent, of spawning this ship class. */
    probability: number,
};

/**
 * A dude: a container for ship classes that share an AI type, governmental
 * affiliation, and boarding booty. When another resource references a dude,
 * Nova picks a concrete ship class from this list using the probabilities.
 *
 * Field layout follows ResForge's düde template (88 bytes), documented in the
 * EVN Bible pp. 24-25.
 */
class DudeResource extends BaseResource {
    /**
     * AI type used by ships of this dude class: 1=Wimpy Trader, 2=Brave
     * Trader, 3=Warship, 4=Interceptor. 0 makes each ship use its inherent AI.
     */
    aiType: number;
    /** Government of this dude class; -1 for independent. */
    govt: number;

    /** Booty flags: what a boarded ship of this class yields. */
    flags: number;
    carriesFood: boolean;
    carriesIndustrial: boolean;
    carriesMedical: boolean;
    carriesLuxury: boolean;
    carriesMetal: boolean;
    carriesEquipment: boolean;
    carriesMoney: boolean;
    /** Ships of this class can't be hit by (and can't hit) the player. */
    immuneToPlayer: boolean;

    /**
     * Raw InfoTypes / Specific-Advice W-container (offset 6). The high four
     * bits are the info-display flags; the low 12 bits are the specific-advice
     * STR# index (added to 7500 to get the resource id).
     */
    infoTypes: number;
    hasGenericGovtHail: boolean;
    hasSpecificAdvice: boolean;
    hasDisasterInfo: boolean;
    hasGoodPrices: boolean;
    /** STR# index for specific advice; add 7500 for the resource id. */
    specificAdviceStrIndex: number;

    /** Ship classes this dude can spawn, with probabilities; unused omitted. */
    ships: Array<DudeShip>;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.aiType = r.int16();
        this.govt = r.int16(-1);

        this.flags = r.uint16();
        this.carriesFood = Boolean(this.flags & 0x0001);
        this.carriesIndustrial = Boolean(this.flags & 0x0002);
        this.carriesMedical = Boolean(this.flags & 0x0004);
        this.carriesLuxury = Boolean(this.flags & 0x0008);
        this.carriesMetal = Boolean(this.flags & 0x0010);
        this.carriesEquipment = Boolean(this.flags & 0x0020);
        this.carriesMoney = Boolean(this.flags & 0x0040);
        this.immuneToPlayer = Boolean(this.flags & 0x0100);

        this.infoTypes = r.uint16();
        // The four documented info-display bits live in the high nibble of the
        // W-container; the low 12 bits are the specific-advice STR# index.
        this.hasSpecificAdvice = Boolean(this.infoTypes & 0x4000);
        this.hasDisasterInfo = Boolean(this.infoTypes & 0x2000);
        this.hasGoodPrices = Boolean(this.infoTypes & 0x1000);
        this.hasGenericGovtHail = Boolean(this.infoTypes & 0x8000);
        this.specificAdviceStrIndex = this.infoTypes & 0x0fff;

        // 16 ship-class ids (offset 8) then 16 parallel probabilities (offset
        // 40). Zip them, dropping ids that are unset (< 128 / -1).
        const ids = r.array(16, () => r.int16(-1));
        const probs = r.array(16, () => r.int16());
        this.ships = [];
        for (let i = 0; i < 16; i++) {
            if (ids[i] >= 128) {
                this.ships.push({ id: ids[i], probability: probs[i] });
            }
        }
    }
}

export { DudeResource };
