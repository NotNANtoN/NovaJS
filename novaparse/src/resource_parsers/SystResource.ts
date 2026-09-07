import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

class SystResource extends BaseResource {
    position: number[];
    links: Set<number>;
    spobs: number[];
    dudeTypes: number[];
    dudeProbabilities: number[];
    avgShips: number;
    government: number;
    /** Density of the system's asteroid belt, 0 through 10. */
    asteroids: number;
    /** Sensor interference, 0 through 100. */
    interference: number;
    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        var d = resource.data;

        this.position = [d.getInt16(0), d.getInt16(2)];

        this.links = new Set();
        for (let i = 0; i < 16; i++) {
            var link = d.getInt16(4 + i * 2);
            if (link >= 128) {
                this.links.add(link);
            }
        }

        this.spobs = [];
        for (let i = 0; i < 16; i++) {
            var spob = d.getInt16(36 + i * 2);
            if (spob >= 128) {
                this.spobs.push(spob);
            }
        }

        // CSystResource::Save places the eight DudeTypes at byte 68,
        // probabilities at 84, and AvgShips at 100.
        this.dudeTypes = [];
        this.dudeProbabilities = [];
        for (let i = 0; i < 8; i++) {
            this.dudeTypes.push(d.getInt16(68 + i * 2));
            this.dudeProbabilities.push(d.getInt16(84 + i * 2));
        }
        this.avgShips = d.getInt16(100);
        // Govt follows AvgShips in the sÿst resource. Older fixtures may end
        // at AvgShips, in which case the system is independent.
        this.government = d.byteLength >= 104 ? d.getInt16(102) : -1;
        // Asteroids follows Message in the sÿst resource and holds the
        // density of the system's belt, 0 through 10.
        this.asteroids = d.byteLength >= 108 ? d.getInt16(106) : 0;
        // Interference follows Asteroids at offset 108 (EV Nova Bible page 63).
        this.interference = d.byteLength >= 110
            ? Math.max(0, Math.min(100, d.getInt16(108)))
            : 0;
    }
}

export { SystResource }
