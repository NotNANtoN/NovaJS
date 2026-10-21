import { Component } from "nova_ecs/component";
import { Plugin } from "nova_ecs/plugin";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import { World } from "nova_ecs/world";
import { MultiRoom } from "../communication/multi_room_communicator";
import { PlatformResource } from "./platform_plugin";
import { SystemIdResource } from "./system_id_resource";
import { recordServerSystemStepTelemetry } from "./combat_telemetry";


export const SystemComponent = new Component<World>('SystemComponent');

const StepSystemSystem = new System({
    name: "StepSystemSystem",
    args: [SystemComponent] as const,
    step(system) {
        try {
            const isNode = system.resources.get(PlatformResource) === 'node';
            const t0 = isNode ? performance.now() : 0;
            system.step();
            if (isNode) {
                const dt = performance.now() - t0;
                const sysId = system.resources.get(SystemIdResource) ?? system.name ?? 'system';
                recordServerSystemStepTelemetry(sysId, dt, system.entities.size);
            }
        } catch (error) {
            console.error(`[SYSTEM STEP ERROR on ${system.name}]:`, error);
        }
    }
});

export const MultiRoomResource = new Resource<MultiRoom>('MultiRoomResource');

export const NovaPlugin: Plugin = {
    name: 'NovaPlugin',
    async build(world) {
        world.addSystem(StepSystemSystem);
    }
}

