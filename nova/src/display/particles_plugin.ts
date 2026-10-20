import { ParticleConfig } from "novadatainterface/WeaponData";
import { Component } from "nova_ecs/component";
import { Optional } from "nova_ecs/optional";
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
import { ShipComponent } from "../nova_plugin/ship_plugin";
import { DamagedEvent, DisabledComponent } from "../nova_plugin/death_plugin";
import { HitFeedbackEvent } from "../nova_plugin/damage_events";
import { IsIonizedComponent } from "../nova_plugin/ionization_plugin";
import { AsteroidComponent, AsteroidDataComponent } from "../nova_plugin/asteroid_plugin";
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

const MAX_ACTIVE_PARTICLES = 2_400;
const MAX_POOLED_PARTICLES = 2_400;
const particlePool: PIXI.Particle[] = [];

function acquireParticle(
    x: number,
    y: number,
    scale: number,
    tint: number,
    alpha: number,
): PIXI.Particle {
    const pooled = particlePool.pop();
    if (pooled) {
        pooled.x = x;
        pooled.y = y;
        pooled.scaleX = scale;
        pooled.scaleY = scale;
        pooled.tint = tint;
        pooled.alpha = alpha;
        return pooled;
    }
    return new PIXI.Particle({
        texture: PIXI.Texture.WHITE,
        x,
        y,
        scaleX: scale,
        scaleY: scale,
        tint,
        alpha,
    });
}

function releaseParticle(particle: PIXI.Particle): void {
    if (particlePool.length < MAX_POOLED_PARTICLES) {
        particlePool.push(particle);
    }
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
        ParticleContainerResource, ActiveParticlesResource, TimeResource] as const,
    step({ position }, config, container, activeList, time) {
        if (!config || !position) return;
        if (time.frame % 2 !== 0) return;
        const count = Math.min(4, Math.max(1, Math.floor(config.count / 3)));
        for (let i = 0; i < count; i++) {
            if (activeList.length >= MAX_ACTIVE_PARTICLES) break;
            const angle = Math.random() * Math.PI * 2;
            const speed = (config.velocity / 2) * (0.6 + Math.random() * 0.8);
            const lifetime = Math.max(0.05,
                (config.lifeMin + Math.random() * Math.max(0.01, config.lifeMax - config.lifeMin)) / 30);
            const particle = acquireParticle(
                position.x,
                position.y,
                2,
                (config.color ?? 0xffffff) & 0xffffff,
                1,
            );
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
        const count = Math.min(16, Math.max(1, config.count));
        for (let i = 0; i < count; i++) {
            if (activeList.length >= MAX_ACTIVE_PARTICLES) break;
            const angle = Math.random() * Math.PI * 2;
            const speed = (config.velocity / 2) * (0.5 + Math.random() * 1.0);
            const lifetime = Math.max(0.05,
                (config.lifeMin + Math.random() * Math.max(0.01, config.lifeMax - config.lifeMin)) / 30);
            const particle = acquireParticle(
                position.x,
                position.y,
                2.5,
                (config.color ?? 0xffffff) & 0xffffff,
                1,
            );
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

const ShipExhaustParticleSystem = new System({
    name: "ShipExhaustParticleSystem",
    args: [ShipComponent, MovementStateComponent,
        ParticleContainerResource, ActiveParticlesResource, TimeResource] as const,
    step(_ship, movementState, container, activeList, time) {
        if (movementState.accelerating <= 0 || !movementState.position) return;
        if (activeList.length >= MAX_ACTIVE_PARTICLES) return;
        if (time.frame % 2 !== 0) return;

        const forward = movementState.rotation.getUnitVector();
        const offset = 18;
        const originX = movementState.position.x - forward.x * offset;
        const originY = movementState.position.y - forward.y * offset;

        const spreadAngle = (Math.random() - 0.5) * 0.4;
        const exhaustSpeed = 60 + Math.random() * 40;
        const backX = -forward.x * exhaustSpeed + forward.y * spreadAngle * exhaustSpeed;
        const backY = -forward.y * exhaustSpeed - forward.x * spreadAngle * exhaustSpeed;

        const lifetime = 0.35 + Math.random() * 0.15;
        const particle = acquireParticle(originX, originY, 1.8, 0x58c0ff, 0.85);
        container.addParticle(particle);
        activeList.push({
            particle,
            vx: movementState.velocity.x * 0.3 + backX,
            vy: movementState.velocity.y * 0.3 + backY,
            lifetime,
            maxLifetime: lifetime,
        });
    },
});

const DisabledShipSparkSystem = new System({
    name: "DisabledShipSparkSystem",
    args: [
        ShipComponent,
        MovementStateComponent,
        Optional(DisabledComponent),
        Optional(IsIonizedComponent),
        ParticleContainerResource,
        ActiveParticlesResource,
        TimeResource,
    ] as const,
    step(_ship, movementState, disabled, ionized, container, activeList, _time) {
        const isDamaged = Boolean(disabled) || Boolean(ionized);
        if (!isDamaged || !movementState.position) return;
        if (activeList.length >= MAX_ACTIVE_PARTICLES) return;

        // Occasional electrical plasma arcs (approx ~12% chance per frame)
        if (Math.random() > 0.12) return;

        const count = 1 + (Math.random() < 0.25 ? 1 : 0);
        for (let i = 0; i < count; i++) {
            const radius = 8 + Math.random() * 20;
            const posAngle = Math.random() * Math.PI * 2;
            const sparkX = movementState.position.x + Math.cos(posAngle) * radius;
            const sparkY = movementState.position.y + Math.sin(posAngle) * radius;

            const ejectAngle = Math.random() * Math.PI * 2;
            const speed = 25 + Math.random() * 35;
            const lifetime = 0.10 + Math.random() * 0.15;
            const tints = ionized ? [0xa040ff, 0xd070ff, 0x7020ff] : [0x60d0ff, 0x90f0ff, 0xffe060];
            const tint = tints[Math.floor(Math.random() * tints.length)]!;

            const particle = acquireParticle(sparkX, sparkY, 1.5, tint, 1);
            container.addParticle(particle);
            activeList.push({
                particle,
                vx: movementState.velocity.x * 0.5 + Math.cos(ejectAngle) * speed,
                vy: movementState.velocity.y * 0.5 + Math.sin(ejectAngle) * speed,
                lifetime,
                maxLifetime: lifetime,
            });
        }
    },
});

const AsteroidDamageDustSystem = new System({
    name: "AsteroidDamageDustSystem",
    // Browsers only see server-resolved hits as HitFeedbackEvent.
    events: [DamagedEvent, HitFeedbackEvent],
    args: [
        AsteroidComponent,
        Optional(AsteroidDataComponent),
        MovementStateComponent,
        ParticleContainerResource,
        ActiveParticlesResource,
    ] as const,
    step(_asteroid, asteroidData, movementState, container, activeList) {
        if (!movementState.position || activeList.length >= MAX_ACTIVE_PARTICLES) return;
        const count = 8;
        const color = asteroidData?.color ?? 0x8b7d6b;
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 35 + Math.random() * 55;
            const lifetime = 0.35 + Math.random() * 0.30;
            const particle = acquireParticle(
                movementState.position.x + (Math.random() - 0.5) * 16,
                movementState.position.y + (Math.random() - 0.5) * 16,
                1.8,
                color,
                0.85,
            );
            container.addParticle(particle);
            activeList.push({
                particle,
                vx: movementState.velocity.x * 0.4 + Math.cos(angle) * speed,
                vy: movementState.velocity.y * 0.4 + Math.sin(angle) * speed,
                lifetime,
                maxLifetime: lifetime,
            });
        }
    },
});

const ParticleUpdateSystem = new System({
    name: "ParticleUpdateSystem",
    args: [ParticleContainerResource, ActiveParticlesResource, TimeResource, SingletonComponent] as const,
    step(container, activeList, time) {
        if (activeList.length === 0) return;
        const dt = time.delta_s;
        const children = container.particleChildren;
        const canCompactChildrenInPlace = Array.isArray(children);
        let writeIdx = 0;
        let removedAny = false;
        for (let i = 0; i < activeList.length; i++) {
            const item = activeList[i];
            item.lifetime -= dt;
            if (item.lifetime <= 0) {
                removedAny = true;
                if (!canCompactChildrenInPlace) {
                    container.removeParticle(item.particle);
                }
                releaseParticle(item.particle);
            } else {
                item.particle.x += item.vx * dt;
                item.particle.y += item.vy * dt;
                item.particle.alpha = Math.max(0, item.lifetime / item.maxLifetime);
                if (canCompactChildrenInPlace) {
                    children[writeIdx] = item.particle;
                }
                activeList[writeIdx++] = item;
            }
        }
        activeList.length = writeIdx;
        if (canCompactChildrenInPlace && removedAny) {
            children.length = writeIdx;
            container.update();
        }
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
        world.addSystem(ShipExhaustParticleSystem);
        world.addSystem(DisabledShipSparkSystem);
        world.addSystem(AsteroidDamageDustSystem);
        world.addSystem(ParticleUpdateSystem);
    },
    remove(world) {
        world.removeSystem(TrailParticlesProvider);
        world.removeSystem(HitParticlesProvider);
        world.removeSystem(TrailEmitterSystem);
        world.removeSystem(HitEmitterSystem);
        world.removeSystem(ShipExhaustParticleSystem);
        world.removeSystem(DisabledShipSparkSystem);
        world.removeSystem(AsteroidDamageDustSystem);
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
