import * as t from 'io-ts';
import { Emit, Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Entity } from "nova_ecs/entity";
import { EcsEvent } from "nova_ecs/events";
import { Plugin } from "nova_ecs/plugin";
import { EncodedEntity, SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { Provide } from "nova_ecs/provide";
import { System } from "nova_ecs/system";
import { isLeft } from "fp-ts/lib/Either.js";
import { registerSimulationBridgeEvent } from "../communication/simulation_bridge_events.js";
import { deImmerify } from "../util/deimmerify.js";
import { ControlStateEvent } from "./control_state_event.js";
import { PlayerShipSelector } from "./player_ship_plugin.js";
import { SystemIdResource } from "./system_id_resource.js";

export interface InitiateJump {
    to: string /* system uuid */,
}
export const InitiateJumpEvent = new EcsEvent<InitiateJump>('InitiateJumpEvent');

export type JumpRoute = {
    route: string[],
};
export const JumpRouteComponent = new Component<JumpRoute>('JumpRouteComponent');
const JumpRouteProvider = Provide({
    name: 'JumpRouteProvider',
    args: [PlayerShipSelector] as const,
    provided: JumpRouteComponent,
    factory() {
        return { route: [] };
    }
});

export interface FinishJump {
    entity: Entity,
    uuid: string,
    to: string,
}
export const FinishJumpEvent = new EcsEvent<FinishJump, {
    entity: EncodedEntity,
    uuid: string,
    to: string,
}>('FinishJumpEvent');

registerSimulationBridgeEvent({
    event: FinishJumpEvent,
    encode(data, serializer) {
        return {
            entity: serializer.encode(data.entity),
            uuid: data.uuid,
            to: data.to,
        };
    },
    decode(data, serializer) {
        const encoded = data as { entity: EncodedEntity, uuid: string, to: string };
        const decoded = serializer.decode(encoded.entity);
        if (isLeft(decoded)) {
            throw new Error(`Failed to decode entity: ${serializer.describeDecodeFailure(encoded.entity, decoded.left)}`);
        }
        return {
            entity: decoded.right,
            uuid: encoded.uuid,
            to: encoded.to,
        };
    },
});

const JumpFromSystem = new System({
    name: 'JumpFromSystem',
    events: [InitiateJumpEvent],
    args: [GetEntity, UUID, Entities, InitiateJumpEvent, Emit] as const,
    step(entity, uuid, entities, { to }, emit) {
        entities.delete(uuid);
        // TODO: Animation etc.
        deImmerify(entity);
        emit(FinishJumpEvent, { entity, uuid, to }, [uuid]);
    }
});

const PlayerJumpControl = new System({
    name: 'PlayerJumpControl',
    events: [ControlStateEvent],
    args: [ControlStateEvent, Emit, UUID, SystemIdResource, JumpRouteComponent,
        PlayerShipSelector] as const,
    step(controlState, emit, uuid, systemId, jumpRoute) {
        if (controlState.get('hyperjump') === 'start') {
            // TODO: Prevent this from being called twice before a jump.
            const nextSystem = jumpRoute.route.shift();
            if (nextSystem) {
                emit(InitiateJumpEvent, { to: nextSystem }, [uuid]);
            }
        }
    }
});

// For a single system to emit jump events.
export const JumpPlugin: Plugin = {
    name: 'JumpPlugin',
    build(world) {
        world.resources.get(SerializerResource)?.addComponent(JumpRouteComponent, t.type({
            route: t.array(t.string),
        }));
        world.addSystem(JumpFromSystem);
        world.addSystem(PlayerJumpControl);
        world.addSystem(JumpRouteProvider);
    }
};

// // Pass jump events between systems.
// // TODO: Support changing set of systems.
// export const WorldJumpPlugin: Plugin = {
//     name: 'WorldJumpPlugin',
//     build(world) {
//         const systems = world.resources.get(SystemsResource);
//         if (!systems) {
//             throw new Error('World must have systems resource');
//         }

//         for (const [, system] of systems) {
//             system.events.get(FinishJumpEvent).subscribe(
//                 ({ entity, to, uuid }) => {
//                     const destination = systems.get(to) ?? system;
//                     destination.entities.set(uuid, entity);
//                 });
//         }
//     }
// }
