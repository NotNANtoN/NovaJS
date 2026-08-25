import { GameDataInterface } from "novadatainterface/GameDataInterface";
import { Entities, GetWorld } from "nova_ecs/arg_types";
import { AsyncSystem } from "nova_ecs/async_system";
import { MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { Resource } from "nova_ecs/resource";
import { SingletonComponent, World } from "nova_ecs/world";
import { GameDataResource } from "./game_data_resource";
import {
    CompatibilityProfile,
    createEntityBudget,
    EntityBudgetResource,
} from "./entity_budget";
import { makePlanet } from "./make_planet";
import { NpcSpawnPlugin } from "./npc_spawn_plugin";
import {
    PlayerStoreResource,
    PlayerStorePort,
} from "./player_state";
import { SystemIdResource } from "./system_id_resource";
import { SystemPlugin } from "./system_plugin";
import { FIXED_TIME_STEP_MS, TimeResource } from "nova_ecs/plugins/time_plugin";


const AddedPlanetsResource = new Resource<{ val: boolean }>('AddedPlanetsResource');

const MakePlanetsSystem = new AsyncSystem({
    name: 'MakePlanetsSystem',
    args: [GameDataResource, SystemIdResource, Entities, GetWorld,
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

export function makeSystem(
    systemId: string,
    gameData: GameDataInterface,
    playerStore?: PlayerStorePort,
    compatibilityProfile: CompatibilityProfile = 'modern',
) {
    //const system = await gameData.data.System.get(systemId);
    const world = new World(systemId);

    world.resources.set(AddedPlanetsResource, { val: false });
    world.resources.set(GameDataResource, gameData);
    world.resources.set(SystemIdResource, systemId);
    world.resources.set(
        EntityBudgetResource, createEntityBudget(compatibilityProfile));
    if (playerStore !== undefined) {
        world.resources.set(PlayerStoreResource, playerStore);
    }
    world.addSystem(MakePlanetsSystem);
    world.addPlugin(SystemPlugin);
    if (playerStore !== undefined) {
        const time = world.resources.get(TimeResource);
        if (time) {
            // Do not let server wall-clock jitter alter gameplay rates.
            time.fixedDelta_ms = FIXED_TIME_STEP_MS;
        }
    }
    if (playerStore !== undefined) {
        // NPC population is authoritative on the server. Browser-created
        // system worlds must not independently generate ships.
        world.addPlugin(NpcSpawnPlugin);
    }

    return world;
}
