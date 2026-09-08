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
import { SingletonComponent, World } from 'nova_ecs/world';
import {
    AsteroidComponent,
    AsteroidCollisionHazardSystem,
    asteroidCountForDensity,
    AsteroidPlugin,
    makeAsteroid,
    OreComponent,
    oreChunkTons,
    CargoScoopOutfitComponent,
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
import { ArmorComponent, ShieldComponent } from './health_plugin';
import { DeathPlugin, PlayerDeathComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import { HitboxHullComponent, CompositeHull, UpdateHitboxHullSystem } from './collisions_plugin';
import * as SAT from 'sat';
import { Stat } from './stat';
import { PlatformResource } from './platform_plugin';
import { createInitialPlayerState, PlayerStateComponent } from './player_state';
import { SystemIdResource } from './system_id_resource';
import { ExternalImpulseComponent } from './external_impulse';

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

let hazardFixtureId = 0;

async function hazardFixture(platform: 'node' | 'browser' = 'node', pairId = `hazard-${hazardFixtureId++}`) {
    const world = await makeWorld(0);
    await world.addPlugin(DeathPlugin);
    world.resources.set(PlatformResource, platform);
    const hull = () => new CompositeHull([
        new SAT.Polygon(new SAT.Vector(0, 0), [
            new SAT.Vector(-20, -20), new SAT.Vector(20, -20),
            new SAT.Vector(20, 20), new SAT.Vector(-20, 20),
        ]),
    ]);
    const rock = makeAsteroid(SMALL_ASTEROID.id, new Position(0, 0), new Vector(0, 0))
        .addComponent(MultiplayerData, { owner: 'server' })
        .addComponent(HitboxHullComponent, hull());
    world.entities.set(`${pairId}-rock`, rock);
    await settle(world);
    const ship = playerAt(new Position(5, 5), 100)
        .addComponent(ShipComponent, { id: 'nova:128' })
        .addComponent(ShipDataComponent, { physics: { mass: 120 } } as never)
        .addComponent(HitboxHullComponent, hull())
        .addComponent(ShieldComponent, new Stat({ current: 1000, max: 1000, recharge: 0 }))
        .addComponent(ArmorComponent, new Stat({ current: 1000, max: 1000, recharge: 0 }));
    ship.components.get(MovementStateComponent)!.velocity = new Vector(120, 0);
    world.entities.set(`${pairId}-ship`, ship);
    return { world, rock, ship };
}

describe('asteroid hazard reliability', () => {
    it('runs as a singleton rather than once per unrelated entity', () => {
        expect(AsteroidCollisionHazardSystem.args).toContain(SingletonComponent);
    });

    it('uses updated hulls even when the hull updater is registered after the hazard', async () => {
        const { world, rock, ship } = await hazardFixture();
        // Old hulls overlap, but movement has already separated the bodies
        // inside the hazard's broad-phase radius.
        ship.components.get(MovementStateComponent)!.position = new Position(100, 0);
        world.addSystem(UpdateHitboxHullSystem);
        const armor = rock.components.get(ArmorComponent)!.current;
        world.step();
        expect(ship.components.get(ShieldComponent)!.current).toBe(1000);
        expect(rock.components.get(ArmorComponent)!.current).toBe(armor);
        expect(ship.components.has(ExternalImpulseComponent)).toBeFalse();
        // The reverse transition must collide on this tick, not the next.
        ship.components.get(MovementStateComponent)!.position = new Position(5, 5);
        world.step();
        expect(ship.components.get(ShieldComponent)!.current).toBeLessThan(1000);
        expect(ship.components.has(ExternalImpulseComponent)).toBeTrue();
    });

    for (const marker of ['death', 'destruction'] as const) {
        it(`does not damage rocks or queue bounce for a ship marked for ${marker}`, async () => {
            const { world, rock, ship } = await hazardFixture();
            if (marker === 'death') {
                ship.components.set(PlayerDeathComponent, {
                    wreckPosition: [5, 5], visualFallbackAt: 5000,
                });
            } else {
                ship.components.set(DestructionStartedComponent, true);
            }
            const armor = rock.components.get(ArmorComponent)!.current;
            world.step();
            expect(rock.components.get(ArmorComponent)!.current).toBe(armor);
            expect(ship.components.get(ShieldComponent)!.current).toBe(1000);
            expect(ship.components.has(ExternalImpulseComponent)).toBeFalse();
        });
    }

    it('removes hazard and external impulse resources only after their systems', async () => {
        const world = await makeWorld(0);
        await expectAsync(world.removePlugin(AsteroidPlugin)).toBeResolved();
        expect(() => world.step()).not.toThrow();
    });

    it('does not author replicated rock health or ship movement in a browser', async () => {
        const { world, rock, ship } = await hazardFixture('browser');
        const armor = rock.components.get(ArmorComponent)!.current;
        world.step();
        expect(rock.components.get(ArmorComponent)!.current).toBe(armor);
        expect(ship.components.get(ShieldComponent)!.current).toBe(1000);
        expect(ship.components.get(MovementStateComponent)!.velocity.x).toBe(120);
    });

    it('damages client-owned ships and authors an additive bounce for their owner', async () => {
        const { world, rock, ship } = await hazardFixture();
        const armor = rock.components.get(ArmorComponent)!.current;
        world.step();
        expect(ship.components.get(ShieldComponent)!.current).toBeLessThan(1000);
        expect(rock.components.get(ArmorComponent)!.current).toBeLessThan(armor);
        const impulse = ship.components.get(ExternalImpulseComponent)!;
        expect(impulse.sequence).toBe(1);
        expect(impulse.impulses.length).toBe(1);
        expect(impulse.impulses[0].owner).toBe('player');
        expect(ship.components.get(MovementStateComponent)!.velocity.x)
            .toBeCloseTo(120 + impulse.impulses[0].x);
        expect(ship.components.get(MovementStateComponent)!.velocity.y)
            .toBeCloseTo(impulse.impulses[0].y);
    });

    it('retains deflection for server-owned ships', async () => {
        const { world, ship } = await hazardFixture();
        ship.components.set(MultiplayerData, { owner: 'server' });
        world.step();
        expect(ship.components.get(ShieldComponent)!.current).toBeLessThan(1000);
        expect(ship.components.get(MovementStateComponent)!.velocity.x).toBeGreaterThan(120);
    });

    it('does not share pair cooldowns between worlds with the same entity IDs', async () => {
        const pairId = `shared-${hazardFixtureId++}`;
        const first = await hazardFixture('node', pairId);
        const second = await hazardFixture('node', pairId);
        first.world.step();
        second.world.step();
        expect(first.ship.components.get(ShieldComponent)!.current).toBeLessThan(1000);
        expect(second.ship.components.get(ShieldComponent)!.current).toBeLessThan(1000);
    });

    it('does not consume the impact cooldown for contact below the speed threshold', async () => {
        const { world, ship } = await hazardFixture();
        ship.components.get(MovementStateComponent)!.velocity = new Vector(0, 0);
        world.step();
        expect(ship.components.get(ShieldComponent)!.current).toBe(1000);
        world.resources.get(TimeResource)!.time = 100;
        ship.components.get(MovementStateComponent)!.velocity = new Vector(120, 0);
        world.step();
        expect(ship.components.get(ShieldComponent)!.current).toBeLessThan(1000);
    });

    it('expires cooldowns when the world clock moves backwards', async () => {
        const { world, ship } = await hazardFixture();
        world.resources.get(TimeResource)!.time = 1000;
        world.step();
        const health = ship.components.get(ShieldComponent)!.current;
        world.resources.get(TimeResource)!.time = 0;
        world.step();
        expect(ship.components.get(ShieldComponent)!.current).toBeLessThan(health);
    });

    it('suppresses repeat damage until exactly 500ms after a damaging impact', async () => {
        const { world, ship } = await hazardFixture();
        world.step();
        const health = ship.components.get(ShieldComponent)!.current;
        world.resources.get(TimeResource)!.time = 499;
        world.step();
        expect(ship.components.get(ShieldComponent)!.current).toBe(health);
        world.resources.get(TimeResource)!.time = 500;
        world.step();
        expect(ship.components.get(ShieldComponent)!.current).toBeLessThan(health);
    });
});

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

    it('bounces ore and damages shields when ship has no cargo scoop installed', async () => {
        const world = await makeWorld(0);
        const asteroid = makeAsteroid(
            SMALL_ASTEROID.id, new Position(0, 0), new Vector(0, 0));
        asteroid.components.set(MultiplayerData, { owner: 'server' });
        world.entities.set('rock', asteroid);

        world.addComponent(PlayerStateComponent);
        const player = playerAt(new Position(0, 0), 100);
        player.components.set(CargoScoopOutfitComponent, { enabled: false });
        player.components.set(ShieldComponent, new Stat({ current: 50, max: 100, recharge: 0 }));
        world.entities.set('player', player);
        await settle(world);

        asteroid.components.get(ArmorComponent)!.current = 0;
        await settle(world, 10);

        expect(heldTons(world, 'metal')).toBe(0);
        expect(ores(world).length).toBeGreaterThan(0);
        expect(player.components.get(ShieldComponent)!.current).toBeLessThan(50);
    });

    it('collects ore when ship has an active cargo scoop outfit', async () => {
        const world = await makeWorld(0);
        const asteroid = makeAsteroid(
            SMALL_ASTEROID.id, new Position(0, 0), new Vector(0, 0));
        asteroid.components.set(MultiplayerData, { owner: 'server' });
        world.entities.set('rock', asteroid);

        world.addComponent(PlayerStateComponent);
        const player = playerAt(new Position(0, 0), 100);
        player.components.set(CargoScoopOutfitComponent, { enabled: true });
        world.entities.set('player', player);
        await settle(world);

        asteroid.components.get(ArmorComponent)!.current = 0;
        await settle(world, 10);

        expect(heldTons(world, 'metal')).toBe(SMALL_ASTEROID.yield.quantity);
        expect(ores(world).length).toBe(0);
    });

    it('damages ships and asteroids on ram collision and deflects velocity', async () => {
        const world = await makeWorld(0);
        await world.addPlugin(DeathPlugin);

        const asteroid = makeAsteroid(
            SMALL_ASTEROID.id, new Position(0, 0), new Vector(0, 0));
        asteroid.components.set(MultiplayerData, { owner: 'server' });
        asteroid.components.set(HitboxHullComponent, new CompositeHull([
            new SAT.Polygon(new SAT.Vector(0, 0), [
                new SAT.Vector(-20, -20),
                new SAT.Vector(20, -20),
                new SAT.Vector(20, 20),
                new SAT.Vector(-20, 20),
            ])
        ]));
        world.entities.set('rock', asteroid);
        await settle(world);

        const ship = new Entity('ram-ship')
            .addComponent(ShipComponent, { id: 'nova:128' })
            .addComponent(ShipDataComponent, {
                id: 'nova:128',
                name: 'Rammer',
                physics: { mass: 120 },
            } as never)
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(5, 5),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(120, 0),
            })
            .addComponent(HitboxHullComponent, new CompositeHull([
                new SAT.Polygon(new SAT.Vector(5, 5), [
                    new SAT.Vector(-15, -15),
                    new SAT.Vector(15, -15),
                    new SAT.Vector(15, 15),
                    new SAT.Vector(-15, 15),
                ])
            ]))
            .addComponent(ShieldComponent, new Stat({ current: 100, max: 100, recharge: 0 }))
            .addComponent(ArmorComponent, new Stat({ current: 100, max: 100, recharge: 0 }));

        world.entities.set('ship', ship);

        const initialShield = ship.components.get(ShieldComponent)!.current;
        const initialRockArmor = asteroid.components.get(ArmorComponent)!.current;

        // Step world once to trigger collision
        world.step();

        const postShield = ship.components.get(ShieldComponent)!.current;
        const postRockArmor = asteroid.components.get(ArmorComponent)!.current;
        const postVelocity = ship.components.get(MovementStateComponent)!.velocity;

        expect(postShield).toBeLessThan(initialShield);
        expect(postRockArmor).toBeLessThan(initialRockArmor);
        expect(postVelocity.x).not.toBe(120);
    });
});
