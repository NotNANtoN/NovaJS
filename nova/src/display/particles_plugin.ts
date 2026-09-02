import { ParticleConfig } from "novadatainterface/WeaponData";
import { Component } from "nova_ecs/component";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Provide } from "nova_ecs/provide";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import { SingletonComponent } from "nova_ecs/world";
import * as PIXI from "pixi.js";
import { ProjectileDataComponent } from "../nova_plugin/projectile_data";
import { ProjectileCollisionEvent } from "../nova_plugin/projectile_plugin";
import { Space } from "./space_resource";
import { attachGraphic, ManagedGraphic } from './managed_graphic';

export const TrailParticlesComponent =
    new Component<ParticleConfig>('TrailParticlesComponent');

const TrailParticlesProvider = Provide({
    name: "TrailParticlesProvider",
    provided: TrailParticlesComponent,
    args: [ProjectileDataComponent] as const,
    factory(projectileData) {
        return projectileData.trailParticles;
    }
});

export const HitParticlesComponent =
    new Component<ParticleConfig>('HitParticlesComponent');

const HitParticlesProvider = Provide({
    name: "HitParticlesProvider",
    provided: HitParticlesComponent,
    args: [ProjectileDataComponent] as const,
    factory(projectileData) {
        return projectileData.hitParticles;
    }
});

interface ActiveParticle {
    particle: PIXI.Particle;
    vx: number;
    vy: number;
    lifetime: number;
    maxLifetime: number;
}

const ActiveParticlesResource =
    new Resource<ActiveParticle[]>('ActiveParticlesResource');
const ParticleContainerResource =
    new Resource<PIXI.ParticleContainer>('ParticleContainerResource');
const ManagedParticleHandleResource =
    new Resource<ManagedGraphic>('ManagedParticleHandleResource');

const TrailEmitterSystem = new System({
    name: "TrailEmitterSystem",
    args: [MovementStateComponent, TrailParticlesComponent,
        ParticleContainerResource, ActiveParticlesResource] as const,
    step({ position }, config, container, activeList) {
        if (!config || !position) return;
        const count = Math.max(1, Math.floor(config.count / 2));
        for (let i = 0; i < count; i++) {
            if (activeList.length >= 20_000) break;
            const angle = Math.random() * Math.PI * 2;
            const speed = (config.velocity / 2) * (0.6 + Math.random() * 0.8);
            const lifetime = Math.max(0.05,
                (config.lifeMin + Math.random() * Math.max(0.01, config.lifeMax - config.lifeMin)) / 30);
            const particle = new PIXI.Particle({
                texture: PIXI.Texture.WHITE,
                x: position.x,
                y: position.y,
                scaleX: 2,
                scaleY: 2,
                tint: config.color,
                alpha: 1,
            });
            container.addParticle(particle);
            activeList.push({
                particle,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                lifetime,
                maxLifetime: lifetime,
            });
        }
    }
});

const HitEmitterSystem = new System({
    name: "HitEmitterSystem",
    events: [ProjectileCollisionEvent],
    args: [ProjectileDataComponent, MovementStateComponent,
        ParticleContainerResource, ActiveParticlesResource] as const,
    step(projectileData, movementState, container, activeList) {
        const config = projectileData?.hitParticles;
        const position = movementState.position;
        if (!config || !position) return;
        const count = Math.max(1, config.count);
        for (let i = 0; i < count; i++) {
            if (activeList.length >= 20_000) break;
            const angle = Math.random() * Math.PI * 2;
            const speed = (config.velocity / 2) * (0.5 + Math.random() * 1.0);
            const lifetime = Math.max(0.05,
                (config.lifeMin + Math.random() * Math.max(0.01, config.lifeMax - config.lifeMin)) / 30);
            const particle = new PIXI.Particle({
                texture: PIXI.Texture.WHITE,
                x: position.x,
                y: position.y,
                scaleX: 2.5,
                scaleY: 2.5,
                tint: config.color,
                alpha: 1,
            });
            container.addParticle(particle);
            activeList.push({
                particle,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                lifetime,
                maxLifetime: lifetime,
            });
        }
    }
});

const ParticleUpdateSystem = new System({
    name: "ParticleUpdateSystem",
    args: [ParticleContainerResource, ActiveParticlesResource, TimeResource, SingletonComponent] as const,
    step(container, activeList, time) {
        const dt = time.delta_s;
        let writeIdx = 0;
        for (let i = 0; i < activeList.length; i++) {
            const item = activeList[i];
            item.lifetime -= dt;
            if (item.lifetime <= 0) {
                container.removeParticle(item.particle);
            } else {
                item.particle.x += item.vx * dt;
                item.particle.y += item.vy * dt;
                item.particle.alpha = Math.max(0, item.lifetime / item.maxLifetime);
                activeList[writeIdx++] = item;
            }
        }
        activeList.length = writeIdx;
    }
});

export const ParticlesPlugin: Plugin = {
    name: "ParticlesPlugin",
    build(world) {
        const space = world.resources.get(Space);
        if (!space) {
            throw new Error('Expected world to have Space resource');
        }
        const particleContainer = new PIXI.ParticleContainer();
        const activeList: ActiveParticle[] = [];
        world.resources.set(ParticleContainerResource, particleContainer);
        world.resources.set(ActiveParticlesResource, activeList);

        const particleHandle = attachGraphic(space, particleContainer);
        world.resources.set(ManagedParticleHandleResource, particleHandle);

        world.addSystem(TrailParticlesProvider);
        world.addSystem(HitParticlesProvider);
        world.addSystem(TrailEmitterSystem);
        world.addSystem(HitEmitterSystem);
        world.addSystem(ParticleUpdateSystem);
    },
    remove(world) {
        world.removeSystem(TrailParticlesProvider);
        world.removeSystem(HitParticlesProvider);
        world.removeSystem(TrailEmitterSystem);
        world.removeSystem(HitEmitterSystem);
        world.removeSystem(ParticleUpdateSystem);

        const container = world.resources.get(ParticleContainerResource);
        if (container) {
            container.removeParticles();
        }
        world.resources.get(ManagedParticleHandleResource)?.dispose();
        world.resources.delete(ParticleContainerResource);
        world.resources.delete(ActiveParticlesResource);
        world.resources.delete(ManagedParticleHandleResource);
    }
};
