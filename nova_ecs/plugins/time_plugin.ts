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
    /**
     * Server worlds set this to the fixed simulation step. Browser worlds
     * leave it unset and measure elapsed wall time for smooth presentation.
     */
    fixedDelta_ms?: number,
}

export const TimeResource = new Resource<Time>('time');
export const FIXED_TIME_STEP_MS = 1000 / 60;
// A browser world can stop stepping while the start or escape menu is open.
// Do not turn that pause into a large gameplay update on the next frame.
// This is above normal 60/75/120 Hz frame intervals but bounds a UI stall.
export const MAX_WALL_CLOCK_DELTA_MS = 100;

export const TimeSystem = new System({
    name: 'time',
    args: [TimeResource, SingletonComponent] as const,
    step: (time) => {
        if (time.fixedDelta_ms !== undefined) {
            time.delta_ms = time.fixedDelta_ms;
            time.delta_s = time.delta_ms / 1000;
            time.time += time.delta_ms;
            time.frame++;
            return;
        }

        // timeOrigin anchors to the epoch so timestamps stored in replicated
        // components remain comparable between the server and browser.
        const now = performance.timeOrigin + performance.now();
        time.delta_ms = Math.min(
            MAX_WALL_CLOCK_DELTA_MS,
            Math.max(0, now - time.time),
        );
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
