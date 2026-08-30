import 'jasmine';
import { getDefaultAsteroidData } from 'novadatainterface/AsteroidData';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import {
    AsteroidComponent,
    asteroidCountForDensity,
    AsteroidPlugin,
    makeAsteroid,
    OreComponent,
    oreChunkTons,
} from './asteroid_plugin';
import {
    ASTEROID_CULL_RADIUS,
    ASTEROID_SPAWN_MAX_RADIUS,
    ASTEROID_SPAWN_MIN_RADIUS,
    AsteroidSpawnPlugin,
    isBeyondCull,
    ringPosition,
} from './asteroid_spawn_plugin';
import { createEntityBudget, EntityBudgetResource } from './entity_budget';
import { GameDataResource } from './game_data_resource';
import { ArmorComponent } from './health_plugin';
import { PlatformResource } from './platform_plugin';
import { createInitialPlayerState, PlayerStateComponent } from './player_state';
import { SystemIdResource } from './system_id_resource';

const BIG_ASTEROID = {
    ...getDefaultAsteroidData(),
    id: 'nova:131',
    name: 'Metal Huge',
    strength: 300,
    prevalence: 25,
    yield: { commodity: 'metal', quantity: 16 },
    fragments: ['nova:130'],
    fragmentCount: 2,
};

const SMALL_ASTEROID = {
    ...getDefaultAsteroidData(),
    id: 'nova:130',
    name: 'Metal Big',
    strength: 175,
    prevalence: 50,
    yield: { commodity: 'metal', quantity: 12 },
};

function makeGameData(density: number) {
    const asteroids = new Map([
        [BIG_ASTEROID.id, BIG_ASTEROID],
        [SMALL_ASTEROID.id, SMALL_ASTEROID],
    ]);
    return {
        ids: Promise.resolve({ Asteroid: [...asteroids.keys()] }),
        data: {
            System: { get: async () => ({ asteroidDensity: density }) },
            Asteroid: {
                get: async (id: string) => {
                    const data = asteroids.get(id);
                    if (!data) {
                        throw new Error(`no asteroid ${id}`);
                    }
                    return data;
                },
            },
        },
    };
}

async function makeWorld(density: number) {
    const world = new World('asteroid-test');
    world.resources.set(GameDataResource, makeGameData(density) as never);
    world.resources.set(SystemIdResource, 'nova:test');
    world.resources.set(TimeResource, {
        time: 0, delta_ms: 1000 / 60, delta_s: 1 / 60, frame: 0,
    });
    world.resources.set(EntityBudgetResource, createEntityBudget('modern'));
    world.resources.set(PlatformResource, 'node');
    await world.addPlugin(DeltaPlugin);
    await world.addPlugin(AsteroidPlugin);
    await world.addPlugin(AsteroidSpawnPlugin);
    return world;
}

/** Steps the world enough times for asynchronous providers to settle. */
async function settle(world: World, steps = 20) {
    for (let step = 0; step < steps; step++) {
        world.step();
        await Promise.resolve();
    }
}

function asteroidCount(world: World): number {
    return [...world.entities.values()]
        .filter(entity => entity.components.has(AsteroidComponent)).length;
}

function ores(world: World) {
    return [...world.entities.values()]
        .map(entity => entity.components.get(OreComponent))
        .filter(ore => ore !== undefined);
}

function playerAt(position: Position, cargoCapacity: number) {
    const playerState = createInitialPlayerState();
    playerState.cargoCapacity = cargoCapacity;
    return new Entity()
        .addComponent(PlayerStateComponent, playerState)
        .addComponent(MultiplayerData, { owner: 'player' })
        .addComponent(MovementStateComponent, {
            accelerating: 0,
            position,
            rotation: new Angle(0),
            turnBack: false,
            turning: 0,
            velocity: new Vector(0, 0),
        });
}

function heldTons(world: World, commodity: string): number {
    // Player state is mutated through an Immer draft, so it has to be read
    // back from the entity rather than from the object handed to the world.
    const state = world.entities.get('player')!
        .components.get(PlayerStateComponent)!;
    return state.holds
        .filter(hold => hold.commodity === commodity)
        .reduce((total, hold) => total + hold.tons, 0);
}

describe('asteroids', () => {
    it('scales the belt with the system density', () => {
        expect(asteroidCountForDensity(0)).toBe(0);
        expect(asteroidCountForDensity(2)).toBe(6);
        // A maximum-density field fills the modern per-system budget.
        expect(asteroidCountForDensity(10)).toBe(32);
        // Anything larger is clamped.
        expect(asteroidCountForDensity(100)).toBe(32);
    });

    it('keeps a rock in the thinnest field', () => {
        expect(asteroidCountForDensity(0.1)).toBe(1);
    });

    it('splits a yield into whole ton chunks', () => {
        expect(oreChunkTons(0)).toEqual([]);
        expect(oreChunkTons(2)).toEqual([1, 1]);
        expect(oreChunkTons(16)).toEqual([4, 4, 4, 4]);
        expect(oreChunkTons(6)).toEqual([2, 2, 1, 1]);
        expect(oreChunkTons(6).reduce((a, b) => a + b, 0)).toBe(6);
    });

    it('populates a belt in a system with asteroids', async () => {
        const world = await makeWorld(3);
        await settle(world);
        expect(asteroidCount(world)).toBe(asteroidCountForDensity(3));
    });

    it('places new rocks in a ring just outside the view', () => {
        const centre = { x: 500, y: -200 };
        for (let attempt = 0; attempt < 50; attempt++) {
            const spot = ringPosition(centre);
            const distance = Math.hypot(spot.x - centre.x, spot.y - centre.y);
            expect(distance).toBeGreaterThanOrEqual(
                ASTEROID_SPAWN_MIN_RADIUS - 1);
            expect(distance).toBeLessThanOrEqual(
                ASTEROID_SPAWN_MAX_RADIUS + 1);
        }
    });

    it('culls only rocks that fell far behind the pilot', () => {
        const centre = { x: 0, y: 0 };
        expect(isBeyondCull({ x: 0, y: 0 }, centre)).toBeFalse();
        expect(isBeyondCull(
            { x: ASTEROID_CULL_RADIUS - 1, y: 0 }, centre)).toBeFalse();
        expect(isBeyondCull(
            { x: ASTEROID_CULL_RADIUS + 1, y: 0 }, centre)).toBeTrue();
    });

    it('spawns the field within reach of the pilot', async () => {
        const world = await makeWorld(4);
        world.entities.set(
            'pilot', playerAt(new Position(0, 0), 100));
        await settle(world);
        const positions = [...world.entities.values()]
            .filter(entity => entity.components.has(AsteroidComponent))
            .map(entity =>
                entity.components.get(MovementStateComponent)!.position);
        expect(positions.length).toBeGreaterThan(0);
        for (const spot of positions) {
            expect(Math.hypot(spot.x, spot.y))
                .toBeLessThanOrEqual(ASTEROID_CULL_RADIUS);
        }
    });

    it('leaves systems without asteroids empty', async () => {
        const world = await makeWorld(0);
        await settle(world);
        expect(asteroidCount(world)).toBe(0);
    });

    it('tumbles asteroids so their sprite frame advances', async () => {
        const world = await makeWorld(1);
        await settle(world);
        const asteroid = [...world.entities.values()]
            .find(entity => entity.components.has(AsteroidComponent))!;
        asteroid.components.set(AsteroidComponent, {
            id: BIG_ASTEROID.id, spin: 1,
        });
        const movement = asteroid.components.get(MovementStateComponent)!;
        movement.rotation = new Angle(0);
        await settle(world, 5);
        expect(asteroid.components.get(MovementStateComponent)!.rotation.angle)
            .toBeGreaterThan(0);
    });

    it('breaks into fragments and ore when destroyed', async () => {
        const world = await makeWorld(0);
        const asteroid = makeAsteroid(
            BIG_ASTEROID.id, new Position(0, 0), new Vector(0, 0));
        asteroid.components.set(MultiplayerData, { owner: 'server' });
        world.entities.set('rock', asteroid);
        await settle(world);

        asteroid.components.get(ArmorComponent)!.current = 0;
        await settle(world, 5);

        expect(world.entities.has('rock')).toBeFalse();
        expect(asteroidCount(world)).toBe(BIG_ASTEROID.fragmentCount);
        const collected = ores(world);
        expect(collected.length).toBeGreaterThan(0);
        expect(collected.reduce((total, ore) => total + ore!.tons, 0))
            .toBe(BIG_ASTEROID.yield.quantity);
        expect(collected.every(ore => ore!.commodity === 'metal')).toBeTrue();
    });

    it('gives fragments and ore plain, unshared positions', async () => {
        const world = await makeWorld(0);
        const asteroid = makeAsteroid(
            BIG_ASTEROID.id, new Position(120, -40), new Vector(0, 0));
        asteroid.components.set(MultiplayerData, { owner: 'server' });
        world.entities.set('rock', asteroid);
        await settle(world);

        asteroid.components.get(ArmorComponent)!.current = 0;
        await settle(world, 5);

        const spawned = [...world.entities.values()].filter(entity =>
            entity.components.has(AsteroidComponent)
            || entity.components.has(OreComponent));
        expect(spawned.length).toBeGreaterThan(1);

        const positions = spawned.map(entity =>
            entity.components.get(MovementStateComponent)!.position);
        for (const position of positions) {
            // A leaked Immer draft is revoked once the spawning step ends, and
            // any later read of it - such as the multiplayer serializer's -
            // throws. Reading it here is what reproduces that crash.
            expect(() => JSON.stringify(position)).not.toThrow();
            expect(position.x).toBe(120);
            expect(position.y).toBe(-40);
        }
        // Each entity drifts on its own, so they must not share one instance.
        expect(new Set(positions).size).toBe(positions.length);
    });

    it('scoops ore into a nearby ship\'s hold', async () => {
        const world = await makeWorld(0);
        const asteroid = makeAsteroid(
            SMALL_ASTEROID.id, new Position(0, 0), new Vector(0, 0));
        asteroid.components.set(MultiplayerData, { owner: 'server' });
        world.entities.set('rock', asteroid);

        world.addComponent(PlayerStateComponent);
        world.entities.set('player', playerAt(new Position(0, 0), 100));
        await settle(world);

        asteroid.components.get(ArmorComponent)!.current = 0;
        await settle(world, 10);

        expect(heldTons(world, 'metal')).toBe(SMALL_ASTEROID.yield.quantity);
        expect(ores(world).length).toBe(0);
    });

    it('leaves ore floating when the hold is full', async () => {
        const world = await makeWorld(0);
        const asteroid = makeAsteroid(
            SMALL_ASTEROID.id, new Position(0, 0), new Vector(0, 0));
        asteroid.components.set(MultiplayerData, { owner: 'server' });
        world.entities.set('rock', asteroid);

        world.addComponent(PlayerStateComponent);
        world.entities.set('player', playerAt(new Position(0, 0), 4));
        await settle(world);

        asteroid.components.get(ArmorComponent)!.current = 0;
        await settle(world, 10);

        expect(heldTons(world, 'metal')).toBe(4);
        expect(ores(world).length).toBeGreaterThan(0);
    });

    it('does not scoop ore for a distant ship', async () => {
        const world = await makeWorld(0);
        const asteroid = makeAsteroid(
            SMALL_ASTEROID.id, new Position(0, 0), new Vector(0, 0));
        asteroid.components.set(MultiplayerData, { owner: 'server' });
        world.entities.set('rock', asteroid);

        world.addComponent(PlayerStateComponent);
        world.entities.set('player', playerAt(new Position(5_000, 0), 100));
        await settle(world);

        asteroid.components.get(ArmorComponent)!.current = 0;
        await settle(world, 10);

        expect(heldTons(world, 'metal')).toBe(0);
        expect(ores(world).length).toBeGreaterThan(0);
    });
});
