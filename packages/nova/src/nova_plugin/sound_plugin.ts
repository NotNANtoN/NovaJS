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

/**
 * A sound heard only by the emitting ship's own pilot (the hyperspace
 * warp sounds). Emit it targeted at the ship: the display plays it
 * only when a target entity is the local player's ship, so every
 * peer's sim emits identically but each client hears only its own
 * ship. Untargeted SoundEvent remains the everyone-hears channel
 * (weapon fire, explosions).
 */
export const PlayerSoundEvent =
    new EcsEvent<{ id: string, loop?: boolean }>('PlayerSoundEvent');

registerSimulationBridgeEvent({ event: SoundEvent });
registerSimulationBridgeEvent({ event: PlayerSoundEvent });

export const SoundEventPlugin: Plugin = {
    name: 'SoundEventPlugin',
    build(world) {
        const serializer = world.resources.get(SerializerResource);
        serializer?.addEvent(SoundEvent, SoundEventType);
        serializer?.addEvent(PlayerSoundEvent, SoundEventType);
    },
};
