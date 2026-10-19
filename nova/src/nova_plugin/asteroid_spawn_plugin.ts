import { GetWorld, UUID } from 'nova_ecs/arg_types';
import { AsyncSystem } from 'nova_ecs/async_system';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
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
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { PlayerStateComponent } from './player_state';
import { System } from 'nova_ecs/system';
import { Entities } from 'nova_ecs/arg_types';
import { EntityBudgetResource, reserveEntity } from './entity_budget';
import { GameDataResource } from './game_data_resource';
import { pickWeighted } from './npc_spawn_plugin';
import { SystemIdResource } from './system_id_resource';
import {
    CONQUEST_ASTEROID_RESPAWN_MS,
    effectiveAsteroidDensity,
    isConquestMode,
} from './conquest_config';

/** How often the belt is topped back up after asteroids are mined out. */
export const ASTEROID_RESPAWN_INTERVAL_MS = 20_000;

/**
 * A field is only a field if you meet it. Retail keeps its sixteen rocks
 * around the ship rather than sprinkling them over the whole system, so they
 * drift into view constantly instead of hiding in empty space. New rocks
 * appear in a ring just outside the view and are recycled once they fall far
 * behind.
 */
export const ASTEROID_SPAWN_MIN_RADIUS = 1_450;
export const ASTEROID_SPAWN_MAX_RADIUS = 2_350;
export const ASTEROID_CULL_RADIUS = 3_000;
const ASTEROID_INBOUND_MIN_SPEED = 42;
const ASTEROID_INBOUND_MAX_SPEED = 88;

const AsteroidsQuery = new Query([AsteroidComponent] as const, 'Asteroids');
const AsteroidPositionsQuery = new Query([
    UUID, MovementStateComponent, AsteroidComponent,
] as const, 'AsteroidPositions');
const AsteroidFieldPlayersQuery = new Query([
    MovementStateComponent, PlayerStateComponent,
] as const, 'AsteroidFieldPlayers');

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

/** A point in the ring well outside the viewport around a given centre. */
export function ringPosition(
    centre: { x: number, y: number },
    minRadius = ASTEROID_SPAWN_MIN_RADIUS,
    maxRadius = ASTEROID_SPAWN_MAX_RADIUS,
): Position {
    const angle = Math.random() * 2 * Math.PI;
    const radius = minRadius + Math.random() * (maxRadius - minRadius);
    return new Position(
        centre.x + Math.cos(angle) * radius,
        centre.y + Math.sin(angle) * radius);
}

/**
 * Picks an off-screen perimeter spawn position that is outside every player's
 * viewport (`>= ASTEROID_SPAWN_MIN_RADIUS` from all players) and computes a
 * velocity vector that flies inward from the outside toward the middle/belt
 * of the system so asteroids never pop into existence on-screen.
 */
export function offscreenAsteroidSpawn(
    players: ReadonlyArray<readonly [{ position: Position }, unknown]>,
): { position: Position; velocity: Vector } {
    const primaryCentre = players[0]?.[0].position ?? new Position(0, 0);
    let spawnPos = ringPosition(primaryCentre);
    for (let attempt = 0; attempt < 16; attempt++) {
        const candidate = ringPosition(primaryCentre);
        const hiddenFromAll = players.every(([mov]) => {
            const dx = candidate.x - mov.position.x;
            const dy = candidate.y - mov.position.y;
            return dx * dx + dy * dy >= (ASTEROID_SPAWN_MIN_RADIUS - 50) ** 2;
        });
        if (hiddenFromAll) {
            spawnPos = candidate;
            break;
        }
    }

    // Aim inward from the outer perimeter toward a point in the central belt
    // around the system center / player area so rocks cruise through the middle.
    const targetAnchor = Math.random() < 0.65
        ? new Position(0, 0)
        : primaryCentre;
    const aimPoint = new Position(
        targetAnchor.x + (Math.random() - 0.5) * 1_100,
        targetAnchor.y + (Math.random() - 0.5) * 1_100,
    );
    const toInterior = aimPoint.subtract(spawnPos);
    const baseAngle = toInterior.lengthSquared > 1
        ? Math.atan2(toInterior.y, toInterior.x)
        : Math.atan2(-spawnPos.y, -spawnPos.x);
    const angle = baseAngle + (Math.random() - 0.5) * 0.45;
    const speed = ASTEROID_INBOUND_MIN_SPEED
        + Math.random() * (ASTEROID_INBOUND_MAX_SPEED - ASTEROID_INBOUND_MIN_SPEED);
    const velocity = new Vector(
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
    );
    return { position: spawnPos, velocity };
}

export function isBeyondCull(
    position: { x: number, y: number },
    centre: { x: number, y: number },
    cullRadius = ASTEROID_CULL_RADIUS,
): boolean {
    const dx = position.x - centre.x;
    const dy = position.y - centre.y;
    return dx * dx + dy * dy > cullRadius * cullRadius;
}

const activeWorlds = new WeakSet<World>();

const AsteroidSpawnSystem = new AsyncSystem({
    name: 'AsteroidSpawn',
    args: [SingletonComponent, GameDataResource, SystemIdResource,
        TimeResource, AsteroidSpawnStateResource, AsteroidsQuery, GetWorld,
        EntityBudgetResource, AsteroidFieldPlayersQuery] as const,
    exclusive: true,
    async step(_singleton, gameData, systemId, time, state, asteroids, world,
        budget, players) {
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
            const hasConquest = players.some(([, pState]) => isConquestMode(pState));
            density = effectiveAsteroidDensity(systemId, density, hasConquest);
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
            // Loading the asteroid table takes long enough that the world has
            // stepped again, which revokes the drafts this step is holding.
            // Reading `players` or `state` past this point would throw, so the
            // belt is laid on the next tick with drafts that are still live.
            return;
        }

        const hasConquest = players.some(([, pState]) => isConquestMode(pState));
        if (hasConquest) {
            const conquestTarget = asteroidCountForDensity(
                effectiveAsteroidDensity(systemId, 0, true),
            );
            if (state.target < conquestTarget) {
                state.target = conquestTarget;
            }
        }
        if (asteroids.length >= state.target) {
            return;
        }
        if (time.time < state.nextSpawnAt) {
            return;
        }

        // Place new rocks off-screen on the outer perimeter flying inward
        // toward the middle of the system so rocks never pop up in view.
        const isRespawn = state.spawnedInitialBelt;
        const missing = isRespawn
            ? (hasConquest ? Math.min(4, state.target - asteroids.length) : 1)
            : state.target - asteroids.length;
        state.spawnedInitialBelt = true;
        state.nextSpawnAt = time.time + (
            hasConquest ? CONQUEST_ASTEROID_RESPAWN_MS : ASTEROID_RESPAWN_INTERVAL_MS
        );

        for (let index = 0; index < missing; index++) {
            const type = pickWeighted(state.types);
            if (!type) {
                break;
            }
            const { position: spawnPos, velocity: spawnVel } =
                players.length > 0 || isRespawn
                    ? offscreenAsteroidSpawn(players)
                    : (() => {
                        const pos = beltPosition();
                        const aim = new Position(
                            (Math.random() - 0.5) * 1_200,
                            (Math.random() - 0.5) * 1_200,
                        ).subtract(pos);
                        const spd = ASTEROID_INBOUND_MIN_SPEED
                            + Math.random() * (ASTEROID_INBOUND_MAX_SPEED - ASTEROID_INBOUND_MIN_SPEED);
                        const vel = aim.lengthSquared > 1
                            ? aim.normalize().scale(spd)
                            : new Vector(spd, 0);
                        return { position: pos, velocity: vel };
                    })();
            const asteroid = makeAsteroid(type.id, spawnPos, spawnVel);
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

/**
 * Recycle rocks that have drifted far past the outer cull boundary by spawning
 * them off-screen on the perimeter with an inward trajectory toward the middle.
 */
const AsteroidRecycleSystem = new System({
    name: 'AsteroidRecycle',
    args: [
        SingletonComponent,
        AsteroidPositionsQuery,
        AsteroidFieldPlayersQuery,
        Entities,
    ] as const,
    step(_singleton, asteroids, players, entities) {
        const centre = players[0]?.[0].position;
        if (!centre) {
            return;
        }
        for (const [uuid, movement] of asteroids) {
            if (!isBeyondCull(movement.position, centre)) {
                continue;
            }
            const AlsoVisibleToOtherPlayer = players.some(([mov]) =>
                !isBeyondCull(movement.position, mov.position, ASTEROID_SPAWN_MIN_RADIUS));
            if (AlsoVisibleToOtherPlayer) {
                continue;
            }
            const entity = entities.get(uuid);
            const state = entity?.components.get(MovementStateComponent);
            if (!state) {
                continue;
            }
            const { position, velocity } = offscreenAsteroidSpawn(players);
            state.position = position;
            state.velocity = velocity;
            entity?.components.set(MovementStateComponent, state);
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
        world.addSystem(AsteroidRecycleSystem);
    },
    remove(world) {
        activeWorlds.delete(world);
        world.removeSystem(AsteroidSpawnSystem);
        world.removeSystem(AsteroidRecycleSystem);
        world.resources.delete(AsteroidSpawnStateResource);
    },
};
