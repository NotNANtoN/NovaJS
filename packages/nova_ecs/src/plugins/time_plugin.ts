import { Resource } from '../resource.js';
import { System } from '../system.js';
import { Plugin } from '../plugin.js';
import { SingletonComponent } from '../world.js';


export interface Time {
    time: number,
    delta_s: number,
    // Snake case here since Ms is Megaseconds
    delta_ms: number,
    frame: number,
}

export const TimeResource = new Resource<Time>('time');

export const TimeSystem = new System({
    name: 'time',
    args: [TimeResource, SingletonComponent] as const,
    step: (time) => {
        // TODO: performance.now for node?
        const now = new Date().getTime();
        time.delta_ms = now - time.time;
        time.delta_s = time.delta_ms / 1000;
        time.time = now;
        time.frame++;
    }
});

export const TimePlugin: Plugin = {
    name: 'time',
    build: (world) => {
        world.resources.set(TimeResource,
            { delta_ms: 0, delta_s: 0, time: new Date().getTime(), frame: 0 });
        world.addSystem(TimeSystem);
    }
}
