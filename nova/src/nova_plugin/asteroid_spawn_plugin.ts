import { GetWorld } from 'nova_ecs/arg_types';
import { AsyncSystem } from 'nova_ecs/async_system';
import { Position } from 'nova_ecs/datatypes/position';
import { Plugin } from 'nova_ecs/plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { SingletonComponent, World } from 'nova_ecs/world';
import { v4 as uuid } from 'uuid';
import {
    ASTEROID_BELT_RADIUS_UNITS,
    AsteroidComponent,
    asteroidCountForDensity,
    makeAsteroid,
} from './asteroid_plugin';
import { EntityBudgetResource, reserveEntity } from './entity_budget';
import { GameDataResource } from './game_data_resource';
import { pickWeighted } from './npc_spawn_plugin';
import { SystemIdResource } from './system_id_resource';

/** How often the belt is topped back up after asteroids are mined out. */
export const ASTEROID_RESPAWN_INTERVAL_MS = 20_000;

const AsteroidsQuery = new Query([AsteroidComponent] as const, 'Asteroids');

interface AsteroidSpawnState {
    initialized: boolean;
    disabled: boolean;
    target: number;
    /** Asteroid ids with their relative likelihood of being picked. */
    types: { id: string, weight: number }[];
    nextSpawnAt: number;
    spawnedInitialBelt: boolean;
}

const AsteroidSpawnStateResource =
    new Resource<AsteroidSpawnState>('AsteroidSpawnState');

function beltPosition(): Position {
    // Spread through the whole belt rather than around its edge so asteroids
    // are encountered on the way to a planet, not only far out.
    const angle = Math.random() * 2 * Math.PI;
    const radius = ASTEROID_BELT_RADIUS_UNITS * Math.sqrt(Math.random());
    return new Position(
        Math.cos(angle) * radius, Math.sin(angle) * radius);
}

const activeWorlds = new WeakSet<World>();

const AsteroidSpawnSystem = new AsyncSystem({
    name: 'AsteroidSpawn',
    args: [SingletonComponent, GameDataResource, SystemIdResource,
        TimeResource, AsteroidSpawnStateResource, AsteroidsQuery, GetWorld,
        EntityBudgetResource] as const,
    exclusive: true,
    async step(_singleton, gameData, systemId, time, state, asteroids, world,
        budget) {
        if (!activeWorlds.has(world) || state.disabled) {
            return;
        }

        if (!state.initialized) {
            state.initialized = true;
            const asteroidData = gameData.data.Asteroid;
            if (!asteroidData) {
                state.disabled = true;
                return;
            }
            let density = 0;
            try {
                density = (await gameData.data.System.get(systemId))
                    .asteroidDensity;
            } catch (_error) {
                state.disabled = true;
                return;
            }
            state.target = asteroidCountForDensity(density);
            if (state.target === 0) {
                state.disabled = true;
                return;
            }

            const ids = (await gameData.ids).Asteroid ?? [];
            const types = await Promise.all(ids.map(async id => {
                try {
                    const data = await asteroidData.get(id);
                    return { id, weight: data.prevalence };
                } catch (_error) {
                    return { id, weight: 0 };
                }
            }));
            state.types = types.filter(type => type.weight > 0);
            if (state.types.length === 0) {
                state.disabled = true;
                return;
            }
            state.spawnedInitialBelt = false;
        }

        if (asteroids.length >= state.target) {
            return;
        }
        if (time.time < state.nextSpawnAt) {
            return;
        }

        // The initial belt appears at once; afterwards a mined out belt
        // refills slowly so it cannot be farmed on the spot.
        const missing = state.spawnedInitialBelt
            ? 1 : state.target - asteroids.length;
        state.nextSpawnAt = time.time + ASTEROID_RESPAWN_INTERVAL_MS;
        state.spawnedInitialBelt = true;

        for (let index = 0; index < missing; index++) {
            const type = pickWeighted(state.types);
            if (!type) {
                break;
            }
            const asteroid = makeAsteroid(type.id, beltPosition());
            if (!reserveEntity(budget, asteroid, 'asteroid')) {
                break;
            }
            if (!activeWorlds.has(world)) {
                // The system was torn down while this step was awaiting.
                budget.release('asteroid');
                return;
            }
            asteroid.components.set(MultiplayerData, { owner: 'server' });
            world.entities.set(uuid(), asteroid);
        }
    },
});

export const AsteroidSpawnPlugin: Plugin = {
    name: 'AsteroidSpawnPlugin',
    build(world) {
        activeWorlds.add(world);
        world.resources.set(AsteroidSpawnStateResource, {
            initialized: false,
            disabled: false,
            target: 0,
            types: [],
            nextSpawnAt: 0,
            spawnedInitialBelt: false,
        });
        world.addSystem(AsteroidSpawnSystem);
    },
    remove(world) {
        activeWorlds.delete(world);
        world.removeSystem(AsteroidSpawnSystem);
        world.resources.delete(AsteroidSpawnStateResource);
    },
};
