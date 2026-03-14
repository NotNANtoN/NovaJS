import { EcsEvent } from 'nova_ecs/events';
import { registerSimulationBridgeEvent } from '../communication/simulation_bridge_events.js';


export const SoundEvent = new EcsEvent<{ id: string, loop?: boolean }>('WeaponFire');

registerSimulationBridgeEvent({ event: SoundEvent });
