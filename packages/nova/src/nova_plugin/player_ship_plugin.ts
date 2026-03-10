import * as t from 'io-ts';
import { Plugin } from 'nova_ecs/plugin';
import { Component } from "nova_ecs/component";
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { System } from 'nova_ecs/system';
import { NewOwnedEntityEvent } from 'nova_ecs/plugins/multiplayer_plugin';
import { Entities } from 'nova_ecs/arg_types';
import { OwnerComponent } from './fire_weapon_plugin.js';


// Used to mark the single ship that's under control.
export const PlayerShipSelector = new Component<undefined>('ShipControl');

const SetControlledShip = new System({
    name: 'SetControlledShip',
    events: [NewOwnedEntityEvent],
    args: [NewOwnedEntityEvent, Entities] as const,
    step: (newEntity, entities) => {
        if (entities.has(newEntity)) {
            for (const entity of entities.values()) {
                entity.components.delete(PlayerShipSelector);
            }
            const entity = entities.get(newEntity);
            entity?.components.set(PlayerShipSelector, undefined);

            // For convenience
            (window as any).myShip = entity;
        }
    }
});

export const PlayerShipPlugin: Plugin = {
    name: 'PlayerShipPlugin',
    build(world) {
        world.resources.get(SerializerResource)?.addComponent(PlayerShipSelector, t.undefined);
        world.addSystem(SetControlledShip);
    }
};
