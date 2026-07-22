import { Component } from 'nova_ecs/component';
import { Plugin } from 'nova_ecs/plugin';
import { TimeResource, TimeSystem } from 'nova_ecs/plugins/time_plugin';
import { Provide } from 'nova_ecs/provide';
import { ProvideArg } from 'nova_ecs/provide_arg';


export const CreateTime = new Component<number>('ProjectileFireTime');
export const CreateTimeProvider = Provide({
    name: "CreateTimeProvider",
    provided: CreateTime,
    args: [TimeResource] as const,
    // Determinism rule 4: stamps entities with time.time as their creation
    // time, so it must run after TimeSystem advances the clock — otherwise
    // an entity created on the first tick after a restore could be stamped
    // with the previous tick's time, diverging peers.
    after: [TimeSystem],
    factory({ time }) {
        return time;
    }
});

// Used in cases where the creation time is needed on the same frame
// e.g. BeamSystem.
export const CreateTimeArgProvider = ProvideArg({
    provided: CreateTime,
    args: [TimeResource] as const,
    factory({ time }) {
        return time;
    }
});

export const CreateTimePlugin: Plugin = {
    name: "CreateTimePlugin",
    build(world) {
        world.addSystem(CreateTimeProvider);
    }
}
