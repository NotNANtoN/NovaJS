import 'jasmine';
import { System } from '../system';
import { World } from '../world';
import {
    MAX_WALL_CLOCK_DELTA_MS,
    Time,
    TimePlugin,
    TimeResource,
    TimeSystem,
} from './time_plugin';

describe('time plugin', () => {
    let clock: jasmine.Clock;
    beforeEach(() => {
        clock = jasmine.clock();
        clock.install();
    });
    afterEach(() => {
        clock.uninstall();
    });

    it('ticks the time', () => {
        clock.mockDate(new Date(100));
        spyOn(performance, 'now').and.returnValues(100, 100, 100, 150, 150);

        const world = new World();
        world.addPlugin(TimePlugin);

        const times: Array<Time> = [];
        // Runs once (on the singleton entity) since there's only one entity.
        const readClockSystem = new System({
            name: 'ReadClock',
            args: [TimeResource],
            step: (time) => {
                times.push({ ...time });
            },
            after: new Set([TimeSystem]),
        });

        world.addSystem(readClockSystem);
        world.step();
        world.step();

        clock.tick(50);
        world.step();
        world.step();

        const origin = performance.timeOrigin;
        expect(times).toEqual([
            { time: origin + 100, delta_ms: 0, delta_s: 0, frame: 1 },
            { time: origin + 100, delta_ms: 0, delta_s: 0, frame: 2 },
            { time: origin + 150, delta_ms: 50, delta_s: 0.05, frame: 3 },
            { time: origin + 150, delta_ms: 0, delta_s: 0, frame: 4 },
        ])
    });

    it('uses the configured fixed simulation step', () => {
        const world = new World();
        world.addPlugin(TimePlugin);
        const time = world.resources.get(TimeResource)!;
        time.time = 0;
        time.fixedDelta_ms = 1000 / 60;

        world.step();
        world.step();

        expect(time.delta_ms).toBe(1000 / 60);
        expect(time.delta_s).toBe(1 / 60);
        expect(time.time).toBe(2000 / 60);
        expect(time.frame).toBe(2);
    });

    it('clamps a long wall-clock pause', () => {
        spyOn(performance, 'now').and.returnValues(100, 100, 10_000);

        const world = new World();
        world.addPlugin(TimePlugin);
        world.step();
        world.step();

        const time = world.resources.get(TimeResource)!;
        expect(time.delta_ms).toBe(MAX_WALL_CLOCK_DELTA_MS);
        expect(time.delta_s).toBe(MAX_WALL_CLOCK_DELTA_MS / 1000);
    });
});
