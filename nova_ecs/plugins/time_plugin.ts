import { Resource } from '../resource';
import { System } from '../system';
import { Plugin } from '../plugin';
import { SingletonComponent } from '../world';


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
        // timeOrigin anchors to the epoch so timestamps stored in replicated
        // components remain comparable between the server and browser.
        const now = performance.timeOrigin + performance.now();
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
            { delta_ms: 0, delta_s: 0, time: performance.timeOrigin + performance.now(), frame: 0 });
        world.addSystem(TimeSystem);
    }
}
