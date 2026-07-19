import { SystemData } from "novadatainterface/system_data";
import { Observable } from "rxjs";
import { DisplayAssetDataInterface } from "../client/gamedata/display_asset_data.js";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { ControlEvent } from "../nova_plugin/controls_plugin.js";
import { Button } from "./button.js";
import { Menu } from "./menu.js";
import { MenuControls } from "./menu_controls.js";
import { computeHypergateSystemLinks, SystemGraph } from "./starmap.js";

/**
 * What the hypergate map is asked to pick, and its answer. `destinationSpob`
 * comes back as the chosen neighbor gate's spöb global id, or null if the map
 * was closed without a pick (the ship lifts off from the origin gate).
 */
export interface GateMapResult {
    /** The gate the ship is docked at (spöb global id). */
    gateSpob: string;
    /** The current system (global id), for centering the map. */
    systemId: string;
    /** Out: the picked neighbor gate's spöb global id, or null. */
    destinationSpob: string | null;
}

/**
 * Computes the systems the hypergate map offers for a gate: every system
 * containing one of the gate's linked destination gates, each mapped back to
 * that destination's spöb global id. Stacked NCB copies of a system can share
 * a gate, so several systems may map to the same spöb — whichever copy the
 * map displays resolves to the right destination. Pure and unit-testable.
 */
export function computeSelectableSystems(
    systemsOfSpob: Map<string, string[]>,
    destinations: string[]): Map<string, string> {
    const selectable = new Map<string, string>();
    for (const dest of destinations) {
        for (const systemId of systemsOfSpob.get(dest) ?? []) {
            selectable.set(systemId, dest);
        }
    }
    return selectable;
}

/**
 * The hypergate transit map: shown when the player lands on a hypergate.
 * Unlike the regular starmap, this map DOES draw the hypergate lanes, and
 * instead of plotting a jump route it picks a destination — restricted to the
 * current gate's immediate neighbors (its HyperLink destinations, EVN Bible
 * p. 61). Reuses the starmap's SystemGraph (bitmap-font labels, baked circle
 * batching, pan/zoom) in its destination-picker mode.
 *
 * Player-local landed UI, like the spaceport: nothing here touches the
 * simulation. The browser applies the result through the same machinery a
 * hyperspace jump uses.
 */
export class GateMap extends Menu<GateMapResult> {
    private systems: SystemData[] = [];
    /** spöb global id -> containing system global ids (stacked NCB copies
     * of a system can share a gate, so a spöb can appear in several). */
    private systemsOfSpob = new Map<string, string[]>();
    /** Hypergate spöb global id -> its destination spöb global ids. */
    private gateDestinations = new Map<string, string[]>();
    private gateLinks: [string, string][] = [];
    private systemGraph?: SystemGraph;
    /** system global id -> the destination spöb that system represents. */
    private selectableSpobs = new Map<string, string>();

    constructor(displayAssets: DisplayAssetDataInterface,
        simulationData: SimulationGameDataInterface,
        controlEvents: Observable<ControlEvent>) {
        super(displayAssets, simulationData, "nova:8509", controlEvents);
        this.container.name = "GateMap";
        const buttons = {
            done: new Button(displayAssets, "Done", 120, { x: 150, y: 220 }),
        };
        this.addButtons(buttons);
        buttons.done.click.subscribe(this.done.bind(this));

        this.controls = new MenuControls(controlEvents, {
            depart: this.done.bind(this),
            map: this.done.bind(this),
        });
    }

    override async build() {
        await super.build();
        const ids = await this.simulationData.ids;
        this.systems = await Promise.all(
            ids.System.map(s => this.simulationData.data.System.get(s)));

        const systemOfSpob = new Map<string, string>();
        for (const system of this.systems) {
            for (const spob of system.planets) {
                if (!systemOfSpob.has(spob)) {
                    systemOfSpob.set(spob, system.id);
                }
                const all = this.systemsOfSpob.get(spob) ?? [];
                all.push(system.id);
                this.systemsOfSpob.set(spob, all);
            }
        }
        await Promise.all([...systemOfSpob.keys()].map(async spob => {
            let planet;
            try {
                planet = await this.simulationData.data.Planet.get(spob);
            } catch {
                return;
            }
            if (planet.gate?.kind === 'hypergate') {
                this.gateDestinations.set(spob, planet.gate.destinations);
            }
        }));
        this.gateLinks =
            computeHypergateSystemLinks(systemOfSpob, this.gateDestinations);
    }

    override async show(input: GateMapResult): Promise<GateMapResult> {
        await this.buildPromise;

        // The systems the player may pick: every system containing one of
        // this gate's linked destination gates.
        this.selectableSpobs = computeSelectableSystems(this.systemsOfSpob,
            this.gateDestinations.get(input.gateSpob) ?? []);

        // A fresh graph per showing: the selectable set is per-gate. The
        // heavy pieces (bitmap label font, texture batching) are shared and
        // this only happens when the player lands on a gate.
        if (this.systemGraph) {
            this.container.removeChild(this.systemGraph.container);
        }
        this.systemGraph = new SystemGraph(this.systems, input.systemId, {
            gateLinks: this.gateLinks,
            selectable: new Set(this.selectableSpobs.keys()),
        });
        this.systemGraph.container.position.set(-290, -248);
        this.container.addChild(this.systemGraph.container);
        this.systemGraph.center();

        return super.show(input);
    }

    override done() {
        const selected = this.systemGraph?.selectedSystem;
        this.input.destinationSpob =
            (selected && this.selectableSpobs.get(selected)) || null;
        super.done();
    }
}
