import { Resource } from "nova_ecs/resource";
import { Time } from "nova_ecs/plugins/time_plugin";

/**
 * The simulation's logical clock, mirrored into the display world by
 * applySimulationFrame each frame. The display world's own
 * TimeResource is wall-clock epoch milliseconds (for smooth
 * rendering), so display systems that compare against sim-clock
 * timestamps carried on components (e.g. DebrisComponent.expires) must
 * read this instead — comparing a sim timestamp against the wall clock
 * is off by ~50 years.
 */
export const SimulationTimeResource = new Resource<Time>('SimulationTime');

/** Before the first frame arrives, the sim clock reads as t=0. */
export function defaultSimulationTime(): Time {
    return { time: 0, delta_s: 0, delta_ms: 0, frame: 0 };
}
