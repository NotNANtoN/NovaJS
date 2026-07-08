import * as t from 'io-ts';
import { Emit, GetEntity, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { EcsEvent } from "nova_ecs/events";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { SerializerResource } from "nova_ecs/plugins/serializer_plugin";
import { System } from "nova_ecs/system";
import { IonizationComponent } from "./health_plugin.js";


/**
 * How much ionization slows a ship. Applied to movement physics by the
 * EffectiveMovementPhysicsSystem in afterburner_plugin.ts.
 */
export const ION_FACTOR = 0.6

export const IonizedEvent = new EcsEvent<boolean>('IonizedEvent');
export const IsIonizedComponent = new Component<boolean>('IsIonizedComponent');

const IonizedSystem = new System({
    name: 'IonizedSystem',
    args: [IonizationComponent, Optional(IsIonizedComponent), GetEntity, UUID, Emit] as const,
    step(ionization, wasIonized, entity, uuid, emit) {
        const isIonized = ionization.current > ionization.max / 2;
        if (isIonized === wasIonized) {
            return;
        }

        entity.components.set(IsIonizedComponent, isIonized);
        emit(IonizedEvent, isIonized, [uuid]);
    }
});

export const IonizedPlugin: Plugin = {
    name: 'IonizedPlugin',
    build(world) {
        world.resources.get(SerializerResource)?.addComponent(IsIonizedComponent, t.boolean);
        world.addSystem(IonizedSystem);
    },
    remove(world) {
        world.removeSystem(IonizedSystem);
    },
}
