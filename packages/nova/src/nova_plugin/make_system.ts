import { MultiplayerData, MultiplayerDataType } from "nova_ecs/plugins/multiplayer_plugin";
import { SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { Random, RandomResource } from "nova_ecs/plugins/random_plugin";
import { useFixedTimestep } from "nova_ecs/plugins/time_plugin";
import { fnv1a } from "nova_ecs/plugins/world_hash";
import { World } from "nova_ecs/world";
import { completeEntity } from "./entity_data_loader.js";
import { IdFactory, IdFactoryResource } from "./id_factory.js";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { SimulationGameDataResource } from "./game_data_resource.js";
import { makePlanet } from "./make_planet.js";
import { Platform, PlatformResource } from "./platform_plugin.js";
import { SystemIdResource } from "./system_id_resource.js";
import { SystemPlugin } from "./system_plugin.js";


/** The simulation runs at a fixed 60Hz. */
export const SIMULATION_STEP_MS = 1000 / 60;

export async function makeSystem(systemId: string, gameData: SimulationGameDataInterface,
    platformOverride?: Platform) {
    const world = new World(systemId);

    world.resources.set(SimulationGameDataResource, gameData);
    world.resources.set(SystemIdResource, systemId);
    // Deterministic randomness and entity id allocation for simulation
    // code. Seeded per system so different systems behave differently
    // while identical runs stay identical.
    world.resources.set(RandomResource, new Random(fnv1a(systemId)));
    world.resources.set(IdFactoryResource, new IdFactory());
    if (platformOverride) {
        world.resources.set(PlatformResource, platformOverride);
    }
    await world.addPlugin(SystemPlugin);
    world.resources.get(SerializerResource)?.addComponent(MultiplayerData, MultiplayerDataType);
    // Simulation worlds run on a fixed timestep with deterministic,
    // 0-based time. Whoever steps the world converts real elapsed time
    // into a number of steps.
    useFixedTimestep(world, SIMULATION_STEP_MS);

    // Load the system's planets before the world ever steps: the
    // simulation must not resolve data asynchronously mid-simulation,
    // so all entities are fully loaded before they are inserted.
    const systemData = await gameData.data.System.get(systemId);
    for (const planetId of systemData.planets) {
        const planetData = await gameData.data.Planet.get(planetId);
        const planet = makePlanet(planetData);
        planet.components.set(MultiplayerData, { owner: 'server' });
        await completeEntity(world, planet);
        world.entities.set(`planet ${planetId}`, planet);
    }

    return world;
}
