import * as t from 'io-ts';
import { PlanetData } from "novadatainterface/planet_data";
import { Emit, Entities, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { passthroughType, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { Provide } from 'nova_ecs/provide';
import { World } from 'nova_ecs/world';
import { ProvideFromCache } from './provide_from_cache.js';
import { registerEntityDeriver } from './entity_factory.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { registerSimulationBridgeEvent } from '../communication/simulation_bridge_events.js';
import { AnimationComponent } from './animation_plugin.js';
import { ControlAction } from './controls.js';
import { findControlledEntity, ShipControlEvent, ShipControlStateComponent } from './ship_control.js';
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

/**
 * Emitted (targeted at the player's ship) when the player presses 'land'
 * with a stellar already selected but the ship is out of the landing
 * window. The reason drives the original's on-screen feedback:
 * "You're too far away to..." or "You're moving too fast to...". Consumed
 * display-side by the status line (status_message_plugin.ts). Never mutates
 * the simulation.
 */
export const LandingBlockedEvent =
    new EcsEvent<{ reason: 'tooFar' | 'tooFast', isStation: boolean }>(
        'LandingBlockedEvent');
export const LandingBlockedEventType = t.type({
    reason: t.union([t.literal('tooFar'), t.literal('tooFast')]),
    isStation: t.boolean,
});

registerSimulationBridgeEvent({ event: LandingBlockedEvent });

/** Landing window: within 100 units (dist²) and slower than ~54.8 (speed²). */
export const LAND_DISTANCE_SQUARED = 10_000;
export const LAND_SPEED_SQUARED = 3_000;

const LandablePlanetsQuery = new Query(
    [UUID, MovementStateComponent, PlanetComponent,
        Optional(PlanetDataComponent)] as const);
const AttemptLandingSystem = new System({
    name: 'AttemptLandingSystem',
    events: [ShipControlEvent] as const,
    args: [LandablePlanetsQuery, UUID,
        MovementStateComponent, PlanetTargetComponent,
        ShipControlStateComponent, Emit] as const,
    step(planets, playerUuid, { position, velocity }, planetTarget, controls, emit) {
        if (controls.get('land') !== 'start') {
            return;
        }

        // With a stellar ALREADY selected, 'land' acts on THAT target: it
        // never retargets to whatever happens to be nearest. Land if inside
        // the window; otherwise give the original's too-far / too-fast
        // feedback. Only when nothing (still in this system) is selected does
        // 'land' pick the nearest stellar (the first press of the two-press
        // land-nearest flow).
        if (planetTarget.target !== undefined) {
            for (const [uuid, { position: planetPosition }, { id }, planetData]
                of planets) {
                if (uuid !== planetTarget.target) {
                    continue;
                }
                const distanceSquared =
                    planetPosition.subtract(position).lengthSquared;
                const isStation = planetData?.flags.isStation ?? false;
                if (distanceSquared >= LAND_DISTANCE_SQUARED) {
                    emit(LandingBlockedEvent, { reason: 'tooFar', isStation },
                        [playerUuid]);
                } else if (velocity.lengthSquared >= LAND_SPEED_SQUARED) {
                    emit(LandingBlockedEvent, { reason: 'tooFast', isStation },
                        [playerUuid]);
                } else {
                    emit(LandEvent, { id, uuid }, [playerUuid]);
                }
                return;
            }
            // The selection is no longer a stellar in this system (jumped
            // away, etc.); fall through and pick the nearest as if unset.
        }

        // No stellar selected: target the nearest one. Ties break on the
        // lexicographically smaller uuid so every peer picks the same stellar
        // regardless of entity-map iteration order (see ChooseTargetSystem).
        let closestUuid: string | undefined = undefined;
        let minSquared = Infinity;
        for (const [uuid, { position: planetPosition }] of planets) {
            const distanceSquared =
                planetPosition.subtract(position).lengthSquared;
            if (distanceSquared < minSquared
                || (distanceSquared === minSquared
                    && closestUuid !== undefined && uuid < closestUuid)) {
                closestUuid = uuid;
                minSquared = distanceSquared;
            }
        }
        planetTarget.target = closestUuid;
    }
});

/**
 * Applies a peer's explicit stellar selection (a tap/click that starts an
 * autopilot to a planet) to the ship it controls, mirroring applySetTarget
 * for ships. Selecting the stellar keeps the land handshake acting on the
 * autopilot's destination even when another stellar was already picked, and
 * lights up the "Stellar Navigation" readout the moment you tap. An invalid
 * choice (not a stellar in this world) is dropped so every peer resolves the
 * input identically. `null` clears the selection.
 */
export function applySetPlanetTarget(world: World, peerId: string | undefined,
    targetUuid: string | null) {
    const found = findControlledEntity(world, peerId);
    if (!found) {
        return;
    }
    const planetTarget = found.entity.components.get(PlanetTargetComponent);
    if (!planetTarget) {
        return;
    }
    if (targetUuid === null) {
        planetTarget.target = undefined;
        return;
    }
    const targetEntity = world.entities.get(targetUuid);
    if (!targetEntity || !targetEntity.components.has(PlanetComponent)) {
        return;
    }
    planetTarget.target = targetUuid;
}

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
            // Hidden stellars (wormholes) are skipped: they never appear in
            // the number-key enumeration, so pressing N selects the Nth
            // NON-wormhole stellar. The order is SystemData.planets (identical
            // on every peer) filtered by each entity's synced, genesis
            // PlanetDataComponent, so the skip is deterministic across peers.
            // Players still transit a wormhole by flying into it and landing
            // (AttemptLandingSystem), which does not go through this selection.
            const selectable = planetIds.filter(id =>
                entities.get(`planet ${id}`)?.components
                    .get(PlanetDataComponent)?.gate?.kind !== 'wormhole');
            const planetId = selectable[i - 1];
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
        world.resources.get(SerializerResource)?.addEvent(
            LandingBlockedEvent, LandingBlockedEventType);
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
