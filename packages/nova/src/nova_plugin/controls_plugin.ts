import * as t from 'io-ts';
import { isLeft } from 'fp-ts/lib/Either.js';
import { Emit } from 'nova_ecs/arg_types';
import { EcsEvent } from 'nova_ecs/events';
import { Plugin } from 'nova_ecs/plugin';
import { EcsKeyboardEvent } from 'nova_ecs/plugins/keyboard_plugin';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { Subject } from 'rxjs';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { registerSimulationBridgeEvent } from '../communication/simulation_bridge_events.js';
import { ControlAction, Controls, getActions, SavedControls } from './controls.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { PlatformResource } from './platform_plugin.js';


export interface ControlEvent {
    action: ControlAction,
    state: false | 'start' | 'repeat',
}

export const ControlsResource = new Resource<Controls>('ControlsResource');
export const EcsControlEvent = new EcsEvent<ControlEvent[]>('ControlEvent');
export const ControlsSubject = new Resource<Subject<ControlEvent>>('ControlsObservable');
export const ControlEventType = t.type({
    action: ControlAction,
    state: t.union([t.literal(false), t.literal('start'), t.literal('repeat')]),
});
export const EcsControlEventType = t.array(ControlEventType);

registerSimulationBridgeEvent({ event: EcsControlEvent });

const ControlEventSystem = new System({
    name: 'ControlEventSystem',
    events: [EcsKeyboardEvent],
    args: [EcsKeyboardEvent, ControlsSubject, ControlsResource,
        Emit, SingletonComponent] as const,
    step(keyboardEvent, controlsSubject, controls, emit) {
        const actions = getActions(controls, keyboardEvent);

        const controlEvents: ControlEvent[] = [];
        for (const action of actions) {
            const controlEvent: ControlEvent = {
                action,
                state: keyboardEvent.type === 'keyup' ? false
                    : keyboardEvent.repeat ? 'repeat' : 'start',
            }

            controlEvents.push(controlEvent);
        }
        emit(EcsControlEvent, controlEvents);
        for (const event of controlEvents) {
            controlsSubject.next(event);
        }
    }
});

export const ControlsPlugin: Plugin = {
    name: 'ControlsPlugin',
    async build(world) {
        world.resources.set(ControlsSubject, new Subject());
        world.resources.get(SerializerResource)?.addEvent(EcsControlEvent, EcsControlEventType);

        const platform = world.resources.get(PlatformResource);
        if (platform === 'browser' || platform === 'worker') {
            const gameData = world.resources.get(SimulationGameDataResource) as SimulationGameDataInterface;
            if (!gameData) {
                throw new Error('Expected world to have gameData');
            }
            if (!gameData.getSettings) {
                throw new Error('Expected simulation game data to provide getSettings');
            }
            const controlsJson = await gameData.getSettings('controls.json');
            const decoded = SavedControls.pipe(Controls).decode(controlsJson);
            if (isLeft(decoded)) {
                console.error(decoded.left);
                throw new Error('Failed to parse controls');
            }
            world.resources.set(ControlsResource, decoded.right);
            if (platform === 'browser') {
                world.addSystem(ControlEventSystem);
            }
            return;
        }
    }
}
