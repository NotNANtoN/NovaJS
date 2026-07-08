import * as t from 'io-ts';
import { PlanetData } from "novadatainterface/planet_data";
import { Emit, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { EcsEvent } from 'nova_ecs/events';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { passthroughType, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { Provide } from 'nova_ecs/provide';
import { ProvideFromCache } from './provide_from_cache.js';
import { registerEntityDeriver } from './entity_factory.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { registerSimulationBridgeEvent } from '../communication/simulation_bridge_events.js';
import { AnimationComponent } from './animation_plugin.js';
import { FuelComponent } from './health_plugin.js';
import { ShipControlEvent, ShipControlStateComponent } from './ship_control.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { PlayerShipSelector } from './player_ship_plugin.js';
import { ShipComponent } from './ship_plugin.js';
import { Target } from './target_component.js';

export const PlanetType = t.type({
    id: t.string // Not a UUID. A nova id.
});
export type PlanetType = t.TypeOf<typeof PlanetType>;

export const PlanetComponent = new Component<PlanetType>('Planet');

export const PlanetDataComponent = new Component<PlanetData>('PlanetData');

function derivePlanetData(gameData: SimulationGameDataInterface, planet: { id: string }) {
    return gameData.data.Planet.getCached(planet.id);
}

export const PlanetDataProvider = ProvideFromCache({
    name: "PlanetDataProvider",
    provided: PlanetDataComponent,
    args: [SimulationGameDataResource, PlanetComponent] as const,
    factory: derivePlanetData,
});

export const PlanetTargetComponent = new Component<Target>('PlanetTargetComponent');

const PlanetTargetProvider = Provide({
    name: "PlanetTargetProvider",
    provided: PlanetTargetComponent,
    args: [ShipComponent] as const,
    factory: () => ({ target: undefined }),
});

export const LandEvent = new EcsEvent<{ id: string, uuid: string }>('LandEvent');
export const LandEventType = t.type({
    id: t.string,
    uuid: t.string,
});

registerSimulationBridgeEvent({ event: LandEvent });

const AttemptLandingSystem = new System({
    name: 'AttemptLandingSystem',
    events: [ShipControlEvent] as const,
    args: [new Query([UUID, MovementStateComponent, PlanetComponent] as const), UUID,
        MovementStateComponent, PlanetTargetComponent,
        ShipControlStateComponent, Emit] as const,
    step(planets, playerUuid, { position, velocity }, planetTarget, controls, emit) {
        if (controls.get('land') === 'start') {
            let minSquared = Infinity;
            let closestUuid: string | undefined = undefined;
            let planetId: string | undefined = undefined;
            for (const [uuid, { position: planetPosition }, { id }] of planets) {
                const distance = planetPosition.subtract(position).lengthSquared;
                if (distance < minSquared) {
                    closestUuid = uuid;
                    minSquared = distance;
                    planetId = id;
                }
            }

            if (planetTarget.target === closestUuid) {
                // Try to land
                if (minSquared < 10_000 && velocity.lengthSquared < 3000
                    && planetId && closestUuid) {
                    emit(LandEvent, { id: planetId, uuid: closestUuid }, [playerUuid]);
                }
            }

            planetTarget.target = closestUuid;
        }
    }
});

/**
 * Ships refuel when they land. Runs in the sim on the landing ship
 * (LandEvent is targeted at it), so every peer computes the same fuel
 * state deterministically. Free for now: when credits exist this
 * becomes a paid transaction (and should move behind the spaceport's
 * refuel prompt instead of being automatic).
 */
const RefuelOnLandingSystem = new System({
    name: 'RefuelOnLandingSystem',
    events: [LandEvent],
    args: [LandEvent, FuelComponent] as const,
    step(_landed, fuel) {
        fuel.current = fuel.max;
    }
});

const PlanetAnimationProvider = Provide({
    name: "PlanetAnimationProvider",
    provided: AnimationComponent,
    update: [PlanetDataComponent],
    args: [PlanetDataComponent],
    factory: planetData => planetData.animation,
});

// TODO: Make planets multiplayer aware
export const PlanetPlugin: Plugin = {
    name: 'PlanetPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }

        world.addComponent(PlanetComponent);
        world.addComponent(PlanetDataComponent);
        registerEntityDeriver(world, {
            name: 'PlanetDataDeriver',
            provided: PlanetDataComponent,
            requires: [PlanetComponent],
            derive: (entity, gameData) =>
                derivePlanetData(gameData, entity.components.get(PlanetComponent)!),
        });
        world.resources.get(SerializerResource)?.addComponent(
            PlanetDataComponent, passthroughType<PlanetData>('PlanetDataComponentType'));
        world.resources.get(SerializerResource)?.addEvent(LandEvent, LandEventType);
        deltaMaker.addComponent(PlanetComponent, {
            componentType: PlanetType,
        });
        deltaMaker.addComponent(PlanetTargetComponent, {
            componentType: Target,
        });
        world.addSystem(PlanetTargetProvider);
        world.addSystem(PlanetAnimationProvider);
        world.addSystem(PlanetDataProvider);
        world.addSystem(AttemptLandingSystem);
        world.addSystem(RefuelOnLandingSystem);
    }
};
