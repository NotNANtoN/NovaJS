import "jasmine";
import { getIntegrationGameData } from "../communication/simulation_test_fixture.js";
import { computeSelectableSystems } from "./gate_map.js";

describe('computeSelectableSystems', () => {
    it('maps each neighbor system to its destination gate spöb', () => {
        const systemsOfSpob = new Map([
            ['gateB', ['systemB']],
            ['gateC', ['systemC', 'systemC-copy']],
        ]);
        const selectable = computeSelectableSystems(
            systemsOfSpob, ['gateB', 'gateC']);
        expect(selectable.get('systemB')).toBe('gateB');
        // Stacked NCB copies of a system both resolve to the same gate.
        expect(selectable.get('systemC')).toBe('gateC');
        expect(selectable.get('systemC-copy')).toBe('gateC');
        expect(selectable.size).toBe(3);
    });

    it('ignores destinations that are in no known system', () => {
        const selectable = computeSelectableSystems(
            new Map(), ['gateNowhere']);
        expect(selectable.size).toBe(0);
    });

    it('offers HG-V01\'s real neighbors from stock data', async () => {
        // HG-V01 (nova:1400) links to HG-V02 (nova:1401, in VNP-002) and
        // HG-S. Manchester (nova:1411). The picker must offer exactly the
        // systems containing those gates — the gate's immediate neighbors —
        // and map them back to the right destination spöbs.
        const gameData = await getIntegrationGameData();
        const ids = await gameData.ids;
        const systems = await Promise.all(
            ids.System.map(s => gameData.data.System.get(s)));
        const systemsOfSpob = new Map<string, string[]>();
        for (const system of systems) {
            for (const spob of system.planets) {
                const all = systemsOfSpob.get(spob) ?? [];
                all.push(system.id);
                systemsOfSpob.set(spob, all);
            }
        }
        const gate = await gameData.data.Planet.get('nova:1400');
        expect(gate.gate?.kind).toBe('hypergate');
        const selectable = computeSelectableSystems(
            systemsOfSpob, gate.gate!.destinations);

        // Every offered system maps to one of the gate's own links...
        for (const spob of selectable.values()) {
            expect(gate.gate!.destinations).toContain(spob);
        }
        // ...and VNP-002 (nova:425), which contains HG-V02, is offered.
        expect(selectable.get('nova:425')).toBe('nova:1401');
    }, 30_000);
});
