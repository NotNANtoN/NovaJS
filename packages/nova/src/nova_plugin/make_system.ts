import { Entities, GetWorld } from "nova_ecs/arg_types";
import { AsyncSystem } from "nova_ecs/async_system";
import { MultiplayerData, MultiplayerDataType } from "nova_ecs/plugins/multiplayer_plugin";
import { SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { Resource } from "nova_ecs/resource";
import { useFixedTimestep } from "nova_ecs/plugins/time_plugin";
import { SingletonComponent, World } from "nova_ecs/world";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { SimulationGameDataResource } from "./game_data_resource.js";
import { makePlanet } from "./make_planet.js";
import { Platform, PlatformResource } from "./platform_plugin.js";
import { SystemIdResource } from "./system_id_resource.js";
import { SystemPlugin } from "./system_plugin.js";


/** The simulation runs at a fixed 60Hz. */
export const SIMULATION_STEP_MS = 1000 / 60;

const AddedPlanetsResource = new Resource<{ val: boolean }>('AddedPlanetsResource');

const MakePlanetsSystem = new AsyncSystem({
    name: 'MakePlanetsSystem',
    args: [SimulationGameDataResource, SystemIdResource, Entities, GetWorld,
        AddedPlanetsResource, SingletonComponent] as const,
    exclusive: true,
    async step(gameData, systemId, entities, world, addedPlanets) {
        if (addedPlanets.val) {
            world.removeSystem(MakePlanetsSystem);
            return;
        }
        const systemData = await gameData.data.System.get(systemId);
        for (const planetId of systemData.planets) {
            const planetData = await gameData.data.Planet.get(planetId);
            const planet = makePlanet(planetData);
            planet.components.set(MultiplayerData, { owner: 'server' });
            entities.set(`planet ${planetId}`, planet);
        }
        addedPlanets.val = true;
    }
});

export async function makeSystem(systemId: string, gameData: SimulationGameDataInterface,
    platformOverride?: Platform) {
    //const system = await gameData.data.System.get(systemId);
    const world = new World(systemId);

    world.resources.set(AddedPlanetsResource, { val: false });
    world.resources.set(SimulationGameDataResource, gameData);
    world.resources.set(SystemIdResource, systemId);
    if (platformOverride) {
        world.resources.set(PlatformResource, platformOverride);
    }
    world.addSystem(MakePlanetsSystem);
    await world.addPlugin(SystemPlugin);
    world.resources.get(SerializerResource)?.addComponent(MultiplayerData, MultiplayerDataType);
    // Simulation worlds run on a fixed timestep with deterministic,
    // 0-based time. Whoever steps the world converts real elapsed time
    // into a number of steps.
    useFixedTimestep(world, SIMULATION_STEP_MS);

    return world;
}
