import { CronData } from 'novadatainterface/cron_data';
import { GovtData } from 'novadatainterface/govt_data';
import { MissionData } from 'novadatainterface/mission_data';
import { PlanetData } from 'novadatainterface/planet_data';
import { SystemData } from 'novadatainterface/system_data';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { StellarInfo, stellarInfoOf } from '../nova_plugin/mission_logic.js';
import { SystemInfo } from '../nova_plugin/mission_ship_logic.js';

/** Maps over `items` with at most `concurrency` calls in flight. */
async function pooledMap<T, R>(items: readonly T[],
    map: (item: T) => Promise<R>, concurrency = 12): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next++;
            results[index] = await map(items[index]);
        }
    }
    await Promise.all(Array.from(
        { length: Math.min(concurrency, items.length) }, worker));
    return results;
}

/**
 * The static data the mission system needs, loaded once per session
 * and shared by the mission computer, the bar, and landing
 * processing: every mission (for offers and for Sxxx lookups), every
 * planet (for random/govt-ranged destinations and name expansion),
 * every system (for planet -> system mapping), and every govt (for
 * stellar matching).
 *
 * Player-local display-side data; the simulation never reads this.
 */
export class MissionUniverse {
    missions: MissionData[] = [];
    crons: CronData[] = [];
    stellarCandidates: StellarInfo[] = [];
    /** Systems, for special/aux ship spawn-system resolution. */
    systemInfos: SystemInfo[] = [];
    private systemInfosById = new Map<string, SystemInfo>();
    private missionsById = new Map<string, MissionData>();
    private planetsById = new Map<string, PlanetData>();
    private govtsById = new Map<string, GovtData>();
    private systemsById = new Map<string, SystemData>();
    private planetSystem = new Map<string, string>();
    private loadPromise?: Promise<void>;

    private static instances =
        new WeakMap<SimulationGameDataInterface, MissionUniverse>();

    constructor(private gameData: SimulationGameDataInterface) { }

    /** One shared universe per game-data instance. */
    static shared(gameData: SimulationGameDataInterface): MissionUniverse {
        let universe = MissionUniverse.instances.get(gameData);
        if (!universe) {
            universe = new MissionUniverse(gameData);
            MissionUniverse.instances.set(gameData, universe);
        }
        return universe;
    }

    /** Idempotent; concurrent callers share one load. */
    load(): Promise<void> {
        this.loadPromise ??= this.doLoad();
        return this.loadPromise;
    }

    private async doLoad() {
        const ids = await this.gameData.ids;
        const data = this.gameData.data;

        // Bounded concurrency: firing thousands of parallel fetches
        // makes Chrome throw ERR_INSUFFICIENT_RESOURCES.
        const [missions, planets, systems, govts, crons] = await Promise.all([
            pooledMap(ids.Mission, async id =>
                [id, await data.Mission.get(id)] as const),
            pooledMap(ids.Planet, async id =>
                [id, await data.Planet.get(id)] as const),
            pooledMap(ids.System, async id =>
                [id, await data.System.get(id)] as const),
            pooledMap(ids.Govt, async id =>
                [id, await data.Govt.get(id)] as const),
            pooledMap(ids.Cron, id => data.Cron.get(id)),
        ]);

        this.missionsById = new Map(missions);
        this.planetsById = new Map(planets);
        this.systemsById = new Map(systems);
        this.govtsById = new Map(govts);
        this.crons = crons;

        this.missions = [...this.missionsById.values()];

        // Only planets that appear in some system are candidate
        // destinations (spöbs can exist without being placed).
        this.planetSystem.clear();
        for (const [systemId, system] of this.systemsById) {
            for (const planetId of system.planets) {
                this.planetSystem.set(planetId, systemId);
            }
        }
        this.stellarCandidates = [...this.planetsById.values()]
            .filter(planet => this.planetSystem.has(planet.id))
            .map(stellarInfoOf);

        this.systemInfos = [...this.systemsById.values()].map(system => ({
            id: system.id,
            govt: system.govt,
            links: [...system.links],
        }));
        this.systemInfosById = new Map(
            this.systemInfos.map(info => [info.id, info]));
    }

    getSystemInfo(systemId: string): SystemInfo | undefined {
        return this.systemInfosById.get(systemId);
    }

    getMission(id: string): MissionData | undefined {
        return this.missionsById.get(id);
    }

    getPlanet(id: string): PlanetData | undefined {
        return this.planetsById.get(id);
    }

    getGovt(id: string): GovtData | undefined {
        return this.govtsById.get(id);
    }

    planetName(id: string | null): string {
        if (!id) {
            return 'nowhere';
        }
        return this.planetsById.get(id)?.name ?? id;
    }

    systemIdOfPlanet(planetId: string): string | undefined {
        return this.planetSystem.get(planetId);
    }

    systemNameOfPlanet(planetId: string | null): string {
        if (!planetId) {
            return 'nowhere';
        }
        const systemId = this.planetSystem.get(planetId);
        if (!systemId) {
            return 'deep space';
        }
        return this.systemsById.get(systemId)?.name ?? systemId;
    }
}
