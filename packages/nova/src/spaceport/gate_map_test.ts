import "jasmine";
import { getDefaultMissionData } from "novadatainterface/mission_data";
import { Entity } from "nova_ecs/entity";
import * as PIXI from "pixi.js";
import { getIntegrationGameData } from "../communication/simulation_test_fixture.js";
import { gateMapMissionMarks } from "../display/gate_map_plugin.js";
import { MissionMapMark } from "../nova_plugin/mission_logic.js";
import { ActiveMission, MissionsComponent } from "../nova_plugin/player_state_plugin.js";
import { computeSelectableSystems, gateMapGraphOptions } from "./gate_map.js";
import { MissionUniverse } from "./mission_universe.js";

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

describe('the hypergate map keeps the starmap\'s mission marks', () => {
    function activeMission(partial: Partial<ActiveMission>): ActiveMission {
        return {
            id: 'nova:200', acceptedDay: 0, acceptedAt: 'nova:128',
            travelPlanet: null, returnPlanet: null, cargoType: -1,
            cargoQty: 0, cargoLoaded: false, travelDone: false,
            deadlineDay: null, ...partial,
        };
    }

    /** A universe stub: one known mission, one placed stellar. */
    function stubUniverse(): MissionUniverse {
        return {
            getMission: (id: string) =>
                id === 'nova:200' ? getDefaultMissionData() : undefined,
            systemIdOfPlanet: (planetId: string) =>
                planetId === 'nova:300' ? 'nova:400' : undefined,
        } as unknown as MissionUniverse;
    }

    it('derives the docked ship\'s marks (the entity is out of the world)',
        () => {
            const ship = new Entity('docked').addComponent(MissionsComponent,
                new Map([['nova:200',
                    activeMission({ travelPlanet: 'nova:300' })]]));
            expect(gateMapMissionMarks(ship, stubUniverse())).toEqual([
                {
                    systemId: 'nova:400', kind: 'destination',
                    missionId: 'nova:200',
                },
            ]);
        });

    it('gives no marks for a pilot with no missions', () => {
        expect(gateMapMissionMarks(new Entity('docked'), stubUniverse()))
            .toEqual([]);
    });

    // The gate map builds its SystemGraph in destination-PICKER mode
    // (selectable + gateLinks). Picker mode must not swallow the marks,
    // and the marks must not touch what is selectable.
    it('carries the marks into the picker-mode graph options', () => {
        const marks: MissionMapMark[] = [
            { systemId: 'nova:400', kind: 'destination', missionId: 'nova:200' },
        ];
        const options = gateMapGraphOptions([['a', 'b']], new Set(['b']),
            marks, PIXI.Texture.EMPTY);
        expect(options.missionMarks).toEqual(marks);
        expect(options.missionMarkTextures?.active).toBe(PIXI.Texture.EMPTY);
        // Still a destination picker over the gate lanes.
        expect([...options.selectable!]).toEqual(['b']);
        expect(options.gateLinks).toEqual([['a', 'b']]);
        // The BBS-viewed (green) marks are the mission computer's, not
        // this map's.
        expect(options.viewedMarks ?? []).toEqual([]);
    });

    it('draws no marks for a pilot with no missions, and none at all '
        + 'without the icon', () => {
            expect(gateMapGraphOptions([], new Set(), [], PIXI.Texture.EMPTY)
                .missionMarks).toEqual([]);
            expect(gateMapGraphOptions([], new Set(), undefined, undefined)
                .missionMarkTextures).toBeUndefined();
        });
});
