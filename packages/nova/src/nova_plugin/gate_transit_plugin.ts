import * as t from 'io-ts';
import { isLeft } from 'fp-ts/lib/Either.js';
import { Emit, Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Entity } from 'nova_ecs/entity';
import { EcsEvent } from 'nova_ecs/events';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent, teleport } from 'nova_ecs/plugins/movement_plugin';
import { EncodedEntity, Serializer, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { RandomResource } from 'nova_ecs/plugins/random_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { registerSimulationBridgeEvent } from '../communication/simulation_bridge_events.js';
import { deImmerify } from '../util/deimmerify.js';
import { LandEvent, PlanetComponent, PlanetDataComponent } from './planet_plugin.js';

/**
 * Hypergate / wormhole transit. Landing on a stellar whose spöb has the
 * hypergate (0x1000) or wormhole (0x2000) flag transports the ship to a linked
 * gate/wormhole in another system instead of opening the spaceport (EVN Bible
 * p. 61).
 *
 * This reuses the hyperspace-jump cross-system machinery. Departure emits
 * {@link GateTransitEvent} (mirroring FinishJumpEvent: it carries the whole
 * serialized entity across the worker/room boundary), and the browser's
 * subscription resolves the destination spöb to its system and calls the same
 * `jumpTo` room switch the jump sequence uses. Arrival is positioned in the
 * destination system by {@link GateArrivalSystem}, which teleports the ship to
 * the destination gate/wormhole's own position — the sim world there already
 * has that gate loaded as a planet entity, so no cross-system data lookup is
 * needed mid-step.
 *
 * Determinism: the *choice* of destination (fixed link for a hypergate,
 * seeded-random for a linked or link-less wormhole) is made here in the sim
 * from the replicated RandomResource, so every peer picks the same exit. The
 * spöb -> system *resolution* and the room switch are player-local (only the
 * transiting player follows), exactly like a normal jump.
 */

/**
 * How far outside the destination gate a ship emerges, in pixels. Far enough
 * that the arriving ship is clear of the gate's own landing radius (so a held
 * land key doesn't immediately re-transit) but still visually "at" the gate.
 */
export const GATE_EMERGENCE_DISTANCE = 300;

/**
 * Rides on a transiting ship to its destination system and positions it at the
 * arrival gate. `destinationSpob` is the global id of the gate/wormhole to
 * emerge at; null means a random wormhole whose exit is resolved on arrival by
 * the browser (which knows the full wormhole list). `randomDraw` is a
 * replicated [0,1) draw used to pick that random exit deterministically.
 * Serializer-registered, so it crosses the wire with the entity and rides the
 * default rollback-snapshot codec (no snapshot_policies entry needed).
 */
export const GateArrivalType = t.intersection([
    t.type({
        emergenceAngle: t.union([t.number, t.null]),
        randomDraw: t.number,
    }),
    t.partial({
        destinationSpob: t.union([t.string, t.null]),
    }),
]);
export type GateArrival = t.TypeOf<typeof GateArrivalType>;
export const GateArrivalComponent = new Component<GateArrival>('GateArrival');

export interface GateTransit {
    entity: Entity,
    uuid: string,
    /** The departure gate/wormhole spöb global id (so a random wormhole can be
     * resolved to a *different* exit). */
    fromSpob: string,
    /** Destination gate/wormhole spöb global id, or null for a random
     * wormhole (resolved by the browser from the full wormhole list). */
    destinationSpob: string | null,
}
export const GateTransitEvent = new EcsEvent<GateTransit>('GateTransitEvent');

const EncodedGateTransitEvent = t.type({
    entity: EncodedEntity,
    uuid: t.string,
    fromSpob: t.string,
    destinationSpob: t.union([t.string, t.null]),
});

export function GateTransitEventType(serializer: Serializer) {
    return new t.Type<GateTransit, {
        entity: EncodedEntity,
        uuid: string,
        fromSpob: string,
        destinationSpob: string | null,
    }>(
        'GateTransitEventType',
        (_u): _u is GateTransit => true,
        (input, context) => {
            const encoded = EncodedGateTransitEvent.validate(input, context);
            if (isLeft(encoded)) {
                return encoded;
            }
            const decoded = serializer.decode(encoded.right.entity);
            if (isLeft(decoded)) {
                return t.failure(
                    encoded.right.entity,
                    context,
                    serializer.describeDecodeFailure(encoded.right.entity, decoded.left),
                );
            }
            return t.success({
                entity: decoded.right,
                uuid: encoded.right.uuid,
                fromSpob: encoded.right.fromSpob,
                destinationSpob: encoded.right.destinationSpob,
            });
        },
        (data) => ({
            entity: serializer.encode(data.entity),
            uuid: data.uuid,
            fromSpob: data.fromSpob,
            destinationSpob: data.destinationSpob,
        }),
    );
}

registerSimulationBridgeEvent({ event: GateTransitEvent });

/**
 * On landing, if the landed stellar is a hypergate or wormhole, choose the
 * exit, tag the ship with a {@link GateArrivalComponent}, remove it from this
 * system, and emit {@link GateTransitEvent} to carry it across.
 *
 * Runs on the landing ship (LandEvent is targeted at it). The refuel-on-land
 * system also fires on this event; that is harmless (the ship simply arrives
 * refuelled). The browser's spaceport handler skips gates, so no dock UI opens.
 */
export const GateDepartureSystem = new System({
    name: 'GateDepartureSystem',
    events: [LandEvent],
    args: [LandEvent, GetEntity, UUID, Entities, RandomResource,
        new Query([PlanetComponent, PlanetDataComponent] as const), Emit] as const,
    step(landed, entity, uuid, entities, random, planets, emit) {
        // Find the landed planet's data to read its gate info.
        let gate = undefined;
        for (const [planet, planetData] of planets) {
            if (planet.id === landed.id) {
                gate = planetData.gate;
                break;
            }
        }
        if (!gate) {
            return; // An ordinary planet/station: normal landing.
        }

        // Choose the exit. A hypergate offers the player a choice of any of
        // its links; without a selection UI we take the first link (HOOK: wire
        // a hypergate destination-picker here once the transit prompt exists).
        // A wormhole with links exits at a seeded-random one of them; a
        // link-less wormhole exits at a random other link-less wormhole,
        // resolved by the browser (which has the full list) from randomDraw.
        const randomDraw = random.next();
        let destinationSpob: string | null;
        if (gate.destinations.length === 0) {
            // Random wormhole: exit resolved on the browser side.
            destinationSpob = null;
        } else if (gate.kind === 'hypergate') {
            destinationSpob = gate.destinations[0];
        } else {
            // Wormhole with defined links: seeded-random among them.
            destinationSpob =
                gate.destinations[Math.floor(randomDraw * gate.destinations.length)];
        }

        entity.components.set(GateArrivalComponent, {
            destinationSpob,
            emergenceAngle: gate.emergenceAngle,
            randomDraw,
        });

        entities.delete(uuid);
        deImmerify(entity);
        emit(GateTransitEvent,
            { entity, uuid, fromSpob: landed.id, destinationSpob }, [uuid]);
    },
});

/**
 * The first tick after a transiting ship arrives in the destination system.
 * Teleports it to the arrival gate (matched by spöb global id among the
 * system's planet entities) and clears the arrival marker. The emergence angle
 * (from the source gate's CustSndID) decides which side of the gate the ship
 * appears on; a null angle means "random direction", chosen deterministically
 * from the replicated randomDraw.
 */
export const GateArrivalSystem = new System({
    name: 'GateArrivalSystem',
    args: [GateArrivalComponent, MovementStateComponent, GetEntity,
        new Query([PlanetComponent, MovementStateComponent] as const)] as const,
    step(arrival, movement, entity, planets) {
        // The browser rewrites destinationSpob to a concrete gate before
        // re-inserting the ship (random wormholes are resolved there), so by
        // the time this runs it should name a real gate in this system.
        let gatePosition: Position | undefined;
        if (arrival.destinationSpob) {
            for (const [planet, planetMovement] of planets) {
                if (planet.id === arrival.destinationSpob) {
                    gatePosition = planetMovement.position;
                    break;
                }
            }
        }

        if (gatePosition) {
            // Emerge a fixed distance from the gate, at the emergence angle
            // (or a seeded-random direction when the angle is unspecified).
            const angle = arrival.emergenceAngle !== null
                ? new Angle(arrival.emergenceAngle * Math.PI / 180)
                : new Angle(arrival.randomDraw * 2 * Math.PI - Math.PI);
            const offset = angle.getUnitVector().scale(GATE_EMERGENCE_DISTANCE);
            teleport(movement,
                new Position(gatePosition.x + offset.x,
                    gatePosition.y + offset.y));
        }
        // If the gate wasn't found (shouldn't happen), the ship simply keeps
        // the position it arrived with rather than getting stuck.
        entity.components.delete(GateArrivalComponent);
    },
});

export const GateTransitPlugin: Plugin = {
    name: 'GateTransitPlugin',
    build(world) {
        const serializer = world.resources.get(SerializerResource);
        serializer?.addComponent(GateArrivalComponent, GateArrivalType);
        if (serializer) {
            serializer.addEvent(GateTransitEvent, GateTransitEventType(serializer));
        }
        world.addSystem(GateDepartureSystem);
        world.addSystem(GateArrivalSystem);
    },
};
