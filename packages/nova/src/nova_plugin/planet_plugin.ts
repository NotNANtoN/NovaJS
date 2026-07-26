import * as t from 'io-ts';
import { PlanetData } from "novadatainterface/planet_data";
import { Emit, Entities, UUID } from 'nova_ecs/arg_types';
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
import { ControlAction } from './controls.js';
import { ShipControlEvent, ShipControlStateComponent } from './ship_control.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { SystemIdResource } from './system_id_resource.js';
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

// Stellar-body hotkeys (controls_nits.txt): number keys 1..9 select the
// Nth stellar body in the current system, and resetNav (tilde/backquote)
// clears the selection. Selection routes through the SAME per-player
// PlanetTargetComponent that clicking/landing use, so the statusbar's
// "Stellar Navigation" readout, the on-screen planet reticle, and the
// land handshake all agree with the number-key pick.
//
// Ordering is the system's own SystemData.planets array — the exact order
// make_system.ts spawns the planet entities in, each under the
// deterministic `planet ${planetId}` UUID. getCached(systemId) is warm
// (this world's own system; the make_system staging contract), and the
// system is event-driven on ShipControlEvent (like AttemptLandingSystem),
// so no clock read / after:[TimeSystem] is needed. Display-synced via the
// existing PlanetTargetComponent delta registration.
const NUM_STELLAR_HOTKEYS = 9;
const SelectStellarSystem = new System({
    name: 'SelectStellarSystem',
    events: [ShipControlEvent] as const,
    args: [ShipControlStateComponent, PlanetTargetComponent,
        SystemIdResource, SimulationGameDataResource, Entities] as const,
    step(controls, planetTarget, systemId, gameData, entities) {
        // Tilde/backquote clears the selected stellar body.
        if (controls.get('resetNav') === 'start') {
            planetTarget.target = undefined;
            return;
        }
        for (let i = 1; i <= NUM_STELLAR_HOTKEYS; i++) {
            const action = `selectStellar${i}` as ControlAction;
            if (controls.get(action) !== 'start') {
                continue;
            }
            const planetIds =
                gameData.data.System.getCached(systemId)?.planets ?? [];
            const planetId = planetIds[i - 1];
            if (planetId === undefined) {
                return;
            }
            const uuid = `planet ${planetId}`;
            if (entities.has(uuid)) {
                planetTarget.target = uuid;
            }
            return;
        }
    },
});

// Landing no longer refuels for free: the spaceport's Refuel button
// (spaceport.ts) charges credits, appears only while fuel isn't full,
// and greys out when unaffordable, matching the original game. The
// paid fill commits with the rest of the docked entity's state via the
// launch addEntity input record.

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
        world.addSystem(SelectStellarSystem);
    }
};
