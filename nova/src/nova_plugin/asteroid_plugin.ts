import { AsteroidData } from 'novadatainterface/AsteroidData';
import * as t from 'io-ts';
import { Entities, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementPhysicsComponent,
    MovementStateComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Provide } from 'nova_ecs/provide';
import { ProvideAsync } from 'nova_ecs/provide_async';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { v4 as uuid } from 'uuid';
import { AnimationComponent } from './animation_plugin';
import { CollisionVulnerabilityComponent } from './collision_interaction';
import { EntityBudgetResource, reserveEntity } from './entity_budget';
import { GameDataResource } from './game_data_resource';
import { ArmorComponent } from './health_plugin';
import { PlatformResource } from './platform_plugin';
import {
    allocateCargo,
    getFreeSpace,
    PlayerStateComponent,
} from './player_state';
import { Stat } from './stat';

/** Drift speed of a freshly spawned asteroid, in engine units per second. */
const ASTEROID_DRIFT_SPEED = 30;
/** Radius of the belt around the system centre. */
const ASTEROID_BELT_RADIUS = 4_000;
/**
 * Asteroids spawned per point of a system's density field. Modern fields double
 * classic density to fill wide resolutions nicely while respecting system scale.
 */
const ASTEROIDS_PER_DENSITY = 3.2;
/** Per-system asteroid limit for modern viewports. */
export const MAX_ASTEROIDS_PER_SYSTEM = 32;
/** Radians per second an asteroid tumbles. */
const ASTEROID_MAX_SPIN = 0.6;
/** Ore floats slower than the rock it came from. */
const ORE_DRIFT_SPEED = 18;
/** How close a ship must be to scoop ore, in engine units. */
const ORE_PICKUP_RADIUS = 60;
/** Ore is spread over at most this many chunks. */
const MAX_ORE_CHUNKS = 4;

export const AsteroidType = t.type({
    id: t.string,
    /** Signed tumble rate in radians per second. */
    spin: t.number,
});
export type AsteroidType = t.TypeOf<typeof AsteroidType>;
export const AsteroidComponent = new Component<AsteroidType>('Asteroid');

export const AsteroidDataComponent =
    new Component<AsteroidData>('AsteroidData');

export const OreType = t.type({
    /** The asteroid this came from, used to look up the ore artwork. */
    asteroidId: t.string,
    commodity: t.string,
    tons: t.number,
    spin: t.number,
});
export type OreType = t.TypeOf<typeof OreType>;
export const OreComponent = new Component<OreType>('Ore');

function randomDrift(speed: number): Vector {
    const direction = Math.random() * 2 * Math.PI;
    const magnitude = speed * (0.25 + 0.75 * Math.random());
    return new Vector(
        Math.cos(direction) * magnitude, Math.sin(direction) * magnitude);
}

function randomSpin(max: number): number {
    return (Math.random() * 2 - 1) * max;
}

/**
 * How many rocks a system keeps around the player. A system with any density
 * at all keeps at least one, so a sparse field is still a field.
 */
export function asteroidCountForDensity(density: number): number {
    if (!Number.isFinite(density) || density <= 0) {
        return 0;
    }
    const count = Math.round(Math.min(10, density) * ASTEROIDS_PER_DENSITY);
    return Math.min(MAX_ASTEROIDS_PER_SYSTEM, Math.max(1, count));
}

/**
 * Splits an asteroid's yield into a few floating chunks, the way retail
 * scatters ore around a destroyed rock.
 */
export function oreChunkTons(quantity: number): number[] {
    const total = Math.max(0, Math.floor(quantity));
    if (total === 0) {
        return [];
    }
    const chunks = Math.min(MAX_ORE_CHUNKS, total);
    const base = Math.floor(total / chunks);
    const remainder = total % chunks;
    return Array.from({ length: chunks }, (_value, index) =>
        base + (index < remainder ? 1 : 0));
}

export function makeAsteroid(
    asteroidId: string, position: Position,
    velocity = randomDrift(ASTEROID_DRIFT_SPEED),
): Entity {
    const asteroid = new Entity(`asteroid ${asteroidId}`);
    asteroid.components.set(AsteroidComponent, {
        id: asteroidId,
        spin: randomSpin(ASTEROID_MAX_SPIN),
    });
    asteroid.components.set(MovementStateComponent, {
        accelerating: 0,
        position,
        rotation: new Angle(Math.random() * 2 * Math.PI),
        turnBack: false,
        turning: 0,
        velocity,
    });
    return asteroid;
}

export function makeOre(
    asteroidId: string, commodity: string, tons: number, position: Position,
): Entity {
    const ore = new Entity(`ore ${commodity}`);
    ore.components.set(OreComponent, {
        asteroidId,
        commodity,
        tons,
        spin: randomSpin(ASTEROID_MAX_SPIN * 2),
    });
    ore.components.set(MovementStateComponent, {
        accelerating: 0,
        position,
        rotation: new Angle(Math.random() * 2 * Math.PI),
        turnBack: false,
        turning: 0,
        velocity: randomDrift(ORE_DRIFT_SPEED),
    });
    return ore;
}

const AsteroidDataProvider = ProvideAsync({
    name: 'AsteroidDataProvider',
    provided: AsteroidDataComponent,
    update: [AsteroidComponent],
    args: [AsteroidComponent, GameDataResource] as const,
    factory: async (asteroid, gameData) => {
        const asteroids = gameData.data.Asteroid;
        if (!asteroids) {
            throw new Error('Game data does not provide asteroids');
        }
        return asteroids.get(asteroid.id);
    },
});

const AsteroidAnimationProvider = Provide({
    name: 'AsteroidAnimationProvider',
    provided: AnimationComponent,
    update: [AsteroidDataComponent],
    args: [AsteroidDataComponent] as const,
    factory: data => data.animation,
});

const AsteroidVulnerabilityProvider = Provide({
    name: 'AsteroidVulnerabilityProvider',
    provided: CollisionVulnerabilityComponent,
    args: [AsteroidComponent] as const,
    factory: () => ({ vulnerableTo: new Set(['normal']) }),
});

const AsteroidArmorProvider = Provide({
    name: 'AsteroidArmorProvider',
    provided: ArmorComponent,
    update: [AsteroidDataComponent],
    args: [AsteroidDataComponent, Optional(ArmorComponent)] as const,
    factory: (data, armor) => new Stat({
        current: armor?.current ?? data.strength,
        max: data.strength,
        min: 0,
        // Rock does not heal.
        recharge: 0,
    }),
});

const AsteroidMovementPhysicsProvider = Provide({
    name: 'AsteroidMovementPhysicsProvider',
    provided: MovementPhysicsComponent,
    args: [AsteroidComponent] as const,
    factory: (asteroid) => ({
        acceleration: 0,
        maxVelocity: ASTEROID_DRIFT_SPEED,
        movementType: MovementType.INERTIAL,
        turnRate: Math.abs(asteroid.spin),
    }),
});

const OreDataProvider = ProvideAsync({
    name: 'OreDataProvider',
    provided: AsteroidDataComponent,
    update: [OreComponent],
    args: [OreComponent, GameDataResource] as const,
    factory: async (ore, gameData) => {
        const asteroids = gameData.data.Asteroid;
        if (!asteroids) {
            throw new Error('Game data does not provide asteroids');
        }
        return asteroids.get(ore.asteroidId);
    },
});

const OreAnimationProvider = Provide({
    name: 'OreAnimationProvider',
    provided: AnimationComponent,
    update: [AsteroidDataComponent, OreComponent],
    args: [AsteroidDataComponent, OreComponent] as const,
    factory: data => data.yieldAnimation,
});

const OreMovementPhysicsProvider = Provide({
    name: 'OreMovementPhysicsProvider',
    provided: MovementPhysicsComponent,
    args: [OreComponent] as const,
    factory: (ore) => ({
        acceleration: 0,
        maxVelocity: ORE_DRIFT_SPEED,
        movementType: MovementType.INERTIAL,
        turnRate: Math.abs(ore.spin),
    }),
});

function tumble(
    spinning: { spin: number },
    movement: { rotation: Angle },
    time: { delta_s: number },
    multiplayer: { owner: string },
    platform: string,
) {
    if (platform === 'node' && multiplayer.owner !== 'server') {
        return;
    }
    movement.rotation = movement.rotation.add(spinning.spin * time.delta_s);
}

const AsteroidTumbleSystem = new System({
    name: 'AsteroidTumbleSystem',
    args: [AsteroidComponent, MovementStateComponent, TimeResource,
        MultiplayerData, PlatformResource] as const,
    step: tumble,
});

const OreTumbleSystem = new System({
    name: 'OreTumbleSystem',
    args: [OreComponent, MovementStateComponent, TimeResource,
        MultiplayerData, PlatformResource] as const,
    step: tumble,
});

const AsteroidDestroyedSystem = new System({
    name: 'AsteroidDestroyedSystem',
    args: [AsteroidComponent, AsteroidDataComponent, ArmorComponent,
        MovementStateComponent, UUID, Entities, MultiplayerData,
        PlatformResource, EntityBudgetResource] as const,
    step(asteroid, data, armor, movement, selfUuid, entities, multiplayer,
        platform, budget) {
        if (platform !== 'node' || multiplayer.owner !== 'server') {
            return;
        }
        // Armour is inspected directly rather than through a death event,
        // because asteroids are not ships and take no part in the death
        // plugin's explosion and respawn sequence.
        if (armor.current > 0 || !entities.has(selfUuid)) {
            return;
        }

        // The dying asteroid's position is an Immer draft that is revoked when
        // this step ends, so anything handed to a new entity has to be a plain
        // copy or the draft leaks into that entity and throws when the
        // multiplayer serializer next touches it. Each new entity also needs
        // its own instance, because the movement system mutates it in place.
        const origin = () => new Position(
            movement.position.x, movement.position.y);

        for (let index = 0; index < data.fragmentCount; index++) {
            const fragmentId = data.fragments[index % data.fragments.length];
            if (!fragmentId) {
                break;
            }
            const fragment = makeAsteroid(fragmentId, origin());
            if (!reserveEntity(budget, fragment, 'asteroid')) {
                break;
            }
            fragment.components.set(MultiplayerData, { owner: 'server' });
            entities.set(uuid(), fragment);
        }

        const commodity = data.yield.commodity;
        if (commodity) {
            for (const tons of oreChunkTons(data.yield.quantity)) {
                const ore = makeOre(asteroid.id, commodity, tons, origin());
                if (!reserveEntity(budget, ore, 'asteroid')) {
                    break;
                }
                ore.components.set(MultiplayerData, { owner: 'server' });
                entities.set(uuid(), ore);
            }
        }

        // The budget for this entity is released by the delete handler.
        entities.delete(selfUuid);
    },
});

const OreCollectorsQuery = new Query(
    [MovementStateComponent, PlayerStateComponent] as const, 'OreCollectors');

const OrePickupSystem = new System({
    name: 'OrePickupSystem',
    args: [OreComponent, MovementStateComponent, UUID, Entities,
        OreCollectorsQuery, MultiplayerData, PlatformResource] as const,
    step(ore, movement, selfUuid, entities, collectors, multiplayer, platform) {
        if (platform !== 'node' || multiplayer.owner !== 'server') {
            return;
        }
        for (const [collectorMovement, playerState] of collectors) {
            const distance = collectorMovement.position
                .subtract(movement.position).length;
            if (distance > ORE_PICKUP_RADIUS) {
                continue;
            }
            const room = Math.min(ore.tons, getFreeSpace(playerState));
            if (room <= 0) {
                // A full hold leaves the ore floating so it can be collected
                // after selling, which is how retail behaves.
                continue;
            }
            allocateCargo(playerState, {
                commodity: ore.commodity,
                tons: room,
                isMissionCargo: false,
            });
            if (room >= ore.tons) {
                entities.delete(selfUuid);
            } else {
                ore.tons -= room;
            }
            return;
        }
    },
});

export const AsteroidPlugin: Plugin = {
    name: 'AsteroidPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(AsteroidComponent);
        world.addComponent(AsteroidDataComponent);
        world.addComponent(OreComponent);

        deltaMaker.addComponent(AsteroidComponent, {
            componentType: AsteroidType,
        });
        deltaMaker.addComponent(OreComponent, {
            componentType: OreType,
        });

        world.addSystem(AsteroidDataProvider);
        world.addSystem(AsteroidAnimationProvider);
        world.addSystem(AsteroidVulnerabilityProvider);
        world.addSystem(AsteroidArmorProvider);
        world.addSystem(AsteroidMovementPhysicsProvider);
        world.addSystem(OreDataProvider);
        world.addSystem(OreAnimationProvider);
        world.addSystem(OreMovementPhysicsProvider);
        world.addSystem(AsteroidTumbleSystem);
        world.addSystem(OreTumbleSystem);
        world.addSystem(AsteroidDestroyedSystem);
        world.addSystem(OrePickupSystem);
    },
    remove(world) {
        world.removeSystem(AsteroidDataProvider);
        world.removeSystem(AsteroidAnimationProvider);
        world.removeSystem(AsteroidVulnerabilityProvider);
        world.removeSystem(AsteroidArmorProvider);
        world.removeSystem(AsteroidMovementPhysicsProvider);
        world.removeSystem(OreDataProvider);
        world.removeSystem(OreAnimationProvider);
        world.removeSystem(OreMovementPhysicsProvider);
        world.removeSystem(AsteroidTumbleSystem);
        world.removeSystem(OreTumbleSystem);
        world.removeSystem(AsteroidDestroyedSystem);
        world.removeSystem(OrePickupSystem);
    },
};

export const ASTEROID_BELT_RADIUS_UNITS = ASTEROID_BELT_RADIUS;
