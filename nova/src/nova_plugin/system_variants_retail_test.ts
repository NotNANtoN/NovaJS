import 'jasmine';
import * as path from 'path';
import { NovaDataType } from 'novadatainterface/NovaDataInterface';
import { MissionOfferLocation } from 'novadatainterface/MissionData';
import { retailDataPath, skipWithoutRetailData } from '../../../test/retail_data';
import { SystemVariantIndex, visibleGalaxy } from './system_variants';
import { getOfferableMissions } from './mission_availability';
import { createInitialPlayerState } from './player_state';

/**
 * Guards the assumptions system_variants.ts makes about retail storyline
 * copies. If a plug-in or data change breaks one, this fails with the exact
 * systems involved instead of a pilot landing on the wrong Earth.
 */
describe('retail storyline copies', () => {
    let systems: any[];
    let planets: any[];
    let index: SystemVariantIndex;

    beforeAll(async () => {
        if (!require('fs').existsSync(path.join(retailDataPath(), 'Nova Files'))) return;
        const { NovaParse } = await import('../../../novaparse/NovaParse');
        const parser = new NovaParse(retailDataPath(), false);
        const ids = await parser.ids;
        systems = await Promise.all(ids.System.map(id => parser.data[NovaDataType.System].get(id)));
        planets = await Promise.all(ids.Planet.map(id => parser.data[NovaDataType.Planet].get(id)));
        index = new SystemVariantIndex(systems);
    });

    function sampleBits(): boolean[][] {
        // Every bit that some system visibility expression mentions, set one
        // at a time, plus none and all.
        const mentioned = new Set<number>();
        for (const s of systems) {
            for (const m of (s.visibility ?? '').matchAll(/b(\d+)/g)) mentioned.add(Number(m[1]));
        }
        const all: boolean[] = [];
        for (const bit of mentioned) all[bit] = true;
        return [[], all, ...[...mentioned].map(bit => { const b: boolean[] = []; b[bit] = true; return b; })];
    }

    it('copies share name and position, and nothing else does', () => {
        if (skipWithoutRetailData()) return;
        const byName = new Map<string, Set<string>>();
        for (const s of systems) {
            const key = s.name.trim().toLowerCase();
            byName.set(key, (byName.get(key) ?? new Set()).add(`${s.position}`));
        }
        const ambiguous = [...byName].filter(([, positions]) => positions.size > 1).map(([name]) => name);
        expect(ambiguous).withContext('same system name at different positions').toEqual([]);
    });

    it('the live galaxy has one system per place and no dangling links', () => {
        if (skipWithoutRetailData()) return;
        for (const bits of sampleBits()) {
            const galaxy = visibleGalaxy(systems, planets.map(p => ({ id: p.id })), bits);
            const places = galaxy.systems.map(s => `${s.name}|${s.position}`);
            expect(new Set(places).size).withContext('duplicate places').toBe(places.length);
            const ids = new Set(galaxy.systems.map(s => s.id));
            const dangling = galaxy.systems.flatMap(s =>
                (s.links ?? []).filter((l: string) => !ids.has(l) && index.get(l)).map((l: string) => `${s.id}->${l}`));
            expect(dangling).withContext('links into hidden copies').toEqual([]);
        }
    });

    it('offers the tutorial Trade Center step on the Earth that exists', () => {
        if (skipWithoutRetailData()) return;
        const state = createInitialPlayerState();
        state.missionBits[9200] = true;
        const galaxy = visibleGalaxy(systems,
            planets.map(p => ({ id: p.id, inhabited: p.inhabited, government: p.government })),
            state.missionBits);
        const missions = new Map();
        // Only the tutorial step is needed; availability reads the record.
        return (async () => {
            const { NovaParse } = await import('../../../novaparse/NovaParse');
            const parser = new NovaParse(retailDataPath(), false);
            missions.set('nova:630', await parser.data[NovaDataType.Mission].get('nova:630'));
            const earth = galaxy.planets.find(p => p.id === 'nova:128');
            expect(earth).withContext('Earth 128 exists at game start').toBeDefined();
            expect(galaxy.planets.find(p => p.id === 'nova:426')).toBeUndefined();
            const offers = getOfferableMissions({
                missionIds: ['nova:630'], missions, playerState: state,
                currentPlanet: earth!, currentSystem: galaxy.systems.find(s => s.id === 'nova:130')!,
                offerLocation: MissionOfferLocation.Trading,
                destinationPlanets: galaxy.planets, destinationSystems: galaxy.systems,
                random: () => 0,
            });
            expect(offers.map(m => m.id)).toEqual(['nova:630']);
        })();
    });
});
