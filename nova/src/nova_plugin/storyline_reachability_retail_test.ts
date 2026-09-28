import 'jasmine';
import * as path from 'path';
import { NovaDataType } from 'novadatainterface/NovaDataInterface';
import { MissionData } from 'novadatainterface/MissionData';
import { retailDataPath, skipWithoutRetailData } from '../../../test/retail_data';
import {
    ENGINE_WIRING,
    ReachabilityData,
    reachableMissions,
    RETAIL_DATA_WIRING,
    RETAIL_WIRING,
} from './storyline_reachability';

/**
 * Every faction storyline must stay reachable. When an engine change breaks
 * a link in a chain (a filter that hides round trips, an unexecuted NCB
 * source, a mis-parsed Require) this names the missions that fell out.
 */
describe('retail storyline reachability', () => {
    let data: ReachabilityData;
    let missions: Map<number, MissionData>;

    beforeAll(async () => {
        if (!require('fs').existsSync(path.join(retailDataPath(), 'Nova Files'))) return;
        const { NovaParse } = await import('../../../novaparse/NovaParse');
        const parser = new NovaParse(retailDataPath(), false);
        const ids = await parser.ids;
        const all = <T>(type: NovaDataType, list: readonly string[] | undefined) =>
            Promise.all((list ?? []).map(id => (parser.data as any)[type].get(id) as Promise<T>));
        const [misn, crons, outfits, ships, planets] = await Promise.all([
            all<MissionData>(NovaDataType.Mission, ids.Mission),
            all<any>(NovaDataType.Cron, ids.Cron),
            all<any>(NovaDataType.Outfit, ids.Outfit),
            all<any>(NovaDataType.Ship, ids.Ship),
            all<any>(NovaDataType.Planet, ids.Planet),
        ]);
        data = { missions: misn, crons, outfits, ships, planets };
        missions = new Map(misn.map(m => [Number(m.id.replace(/^.*:/, '')), m]));
    }, 120_000);

    const describeIds = (ids: number[]) =>
        ids.map(id => `${id} ${missions.get(id)?.name}`);

    it('reaches every storyline finale', () => {
        if (skipWithoutRetailData()) return;
        const engine = reachableMissions(data, ENGINE_WIRING);
        // Resource names ending in "LAST" (parsed names drop the ;suffix):
        // Rebel I22, Vellos31, Fed43, Fed26 forced, Auroran 029, Pirate 011,
        // Pirate offshoot 004a, last pirate link.
        const finales = [354, 417, 474, 596, 686, 712, 729, 895];
        expect(finales.every(id => missions.has(id))).toBe(true);
        const unreachable = finales.filter(id => !engine.has(id));
        expect(describeIds(unreachable)).withContext('unreachable finales').toEqual([]);
    });

    it('reaches every first mission of each faction arc', () => {
        if (skipWithoutRetailData()) return;
        const engine = reachableMissions(data, ENGINE_WIRING);
        // Tutorial, Vell-os, Polaris, Fed, Rebel, Auroran, Pirate, Wild Geese,
        // Sigma bulk (Require), ship-offered (përs link), auto-abort helper.
        const entries = [251, 129, 153, 430, 330, 660, 693, 634, 557, 132, 909, 905];
        expect(describeIds(entries.filter(id => !engine.has(id))))
            .withContext('entry missions').toEqual([]);
    });

    it('executes every mechanic EV Nova does', () => {
        if (skipWithoutRetailData()) return;
        const engine = reachableMissions(data, ENGINE_WIRING);
        const retail = reachableMissions(data, RETAIL_WIRING);
        const lost = [...retail].filter(id => !engine.has(id)).sort((a, b) => a - b);
        expect(describeIds(lost)).toEqual([]);
        expect(engine.size).toBeGreaterThan(780);
    });

    it('only needs plug-in planet weapons for the stellar-destruction missions', () => {
        if (skipWithoutRetailData()) return;
        const full = reachableMissions(data, ENGINE_WIRING);
        const vanilla = reachableMissions(data, RETAIL_DATA_WIRING);
        const pluginOnly = [...full].filter(id => !vanilla.has(id)).sort((a, b) => a - b);
        // 615-629 odd ids: "Avoid ..." task forces gated on spöb OnDestroy bits.
        expect(describeIds(pluginOnly))
            .toEqual(describeIds([615, 617, 620, 621, 623, 625, 627, 629]));
    });
});
