import * as t from 'io-ts';
import { Component } from "nova_ecs/component";
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from "nova_ecs/plugins/delta_plugin";
import { excludeFromStateHash, replicationPolicies } from "nova_ecs/plugins/multiplayer_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { System } from "nova_ecs/system";
import { PlatformPlugin, PlatformResource } from "./platform_plugin";
import { applyStatDelta, getStatDelta, PartialStat, stat, Stat } from "./stat";


export const ShieldComponent = new Component<Stat>('Shield');
export const ArmorComponent = new Component<Stat>('Armor');
export const IonizationComponent = new Component<Stat>('Ionization');

// Health stats recharge at 60 Hz on the server while getStatDelta throttles
// recharge packets to 1 Hz; exclude them from 500ms state hashes so recharging
// shields in combat never trigger false-positive full-entity resync requests.
excludeFromStateHash(ShieldComponent.name);
excludeFromStateHash(ArmorComponent.name);
excludeFromStateHash(IonizationComponent.name);

replicationPolicies.register(ShieldComponent, {
    codec: stat,
    authority: 'server',
    acceptInitialOwnerState: true,
});
replicationPolicies.register(ArmorComponent, {
    codec: stat,
    authority: 'server',
    acceptInitialOwnerState: true,
});
replicationPolicies.register(IonizationComponent, {
    codec: stat,
    authority: 'server',
    acceptInitialOwnerState: true,
});

const healthStats = [ShieldComponent, ArmorComponent, IonizationComponent]
    .map(statComponent => [statComponent, new System({
        name: `${statComponent.name}Recharge`,
        args: [statComponent, TimeResource, PlatformResource] as const,
        step(stat, time, platform) {
            // Health is server authority, so a client recharging locally would
            // only fight the values it is sent.
            if (platform !== 'node') {
                return;
            }
            stat.step(time.delta_s);
        }
    })] as const);

export const IonizationColorComponent =
    new Component<{ color: number }>('IonizationColorComponent');
const IonizationColor = t.type({ color: t.number });
replicationPolicies.register(IonizationColorComponent, {
    codec: IonizationColor,
    authority: 'server',
});

export const HealthPlugin: Plugin = {
    name: "HealthPlugin",
    build(world) {
        if (!world.resources.has(PlatformResource)) {
            world.addPlugin(PlatformPlugin);
        }
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }

        for (const [healthComponent, healthRecharge] of healthStats) {
            deltaMaker.addComponent(healthComponent, {
                componentType: stat,
                deltaType: PartialStat,
                getDelta: getStatDelta,
                applyDelta: applyStatDelta,
            });

            world.addSystem(healthRecharge);
        }
        deltaMaker.addComponent(IonizationColorComponent, {
            componentType: IonizationColor,
        });
    }
}

