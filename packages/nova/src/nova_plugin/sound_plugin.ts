import * as t from 'io-ts';
import { EcsEvent } from 'nova_ecs/events';
import { Plugin } from 'nova_ecs/plugin';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { registerSimulationBridgeEvent } from '../communication/simulation_bridge_events.js';


export const SoundEvent = new EcsEvent<{ id: string, loop?: boolean }>('SoundEvent');
export const SoundEventType = t.intersection([
    t.type({
        id: t.string,
    }),
    t.partial({
        loop: t.boolean,
    }),
]);

registerSimulationBridgeEvent({ event: SoundEvent });

export const SoundEventPlugin: Plugin = {
    name: 'SoundEventPlugin',
    build(world) {
        world.resources.get(SerializerResource)?.addEvent(SoundEvent, SoundEventType);
    },
};
