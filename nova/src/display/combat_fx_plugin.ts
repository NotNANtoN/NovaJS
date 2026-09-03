import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { Optional } from 'nova_ecs/optional';
import * as PIXI from 'pixi.js';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { AppliedDamageEvent, DisabledComponent } from '../nova_plugin/death_plugin';
import { ShipDataComponent } from '../nova_plugin/ship_plugin';
import { Space } from './space_resource';
import { attachGraphic, ManagedGraphic } from './managed_graphic';

interface ShieldFlare {
    x: number;
    y: number;
    radius: number;
    startedAt: number;
    duration: number;
}

interface Spark {
    x: number;
    y: number;
    vx: number;
    vy: number;
    color: number;
    startedAt: number;
    duration: number;
}

interface SmokePuff {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    startedAt: number;
    duration: number;
}

export class CombatFxState {
    shieldFlares: ShieldFlare[] = [];
    sparks: Spark[] = [];
    smokePuffs: SmokePuff[] = [];
    lastSmokeAt = new Map<string, number>();
}

export const CombatFxResource = new Resource<CombatFxState>('CombatFxResource');
export const CombatFxGraphics = new Resource<ManagedGraphic>('CombatFxGraphics');

export const ClearCombatFx = new System({
    name: 'ClearCombatFx',
    args: [CombatFxGraphics, SingletonComponent] as const,
    step(graphicsHandle) {
        (graphicsHandle.root as PIXI.Graphics).clear();
    },
});

export const RecordDamageFxSystem = new System({
    name: 'RecordDamageFxSystem',
    events: [AppliedDamageEvent],
    args: [
        AppliedDamageEvent,
        MovementStateComponent,
        Optional(ShipDataComponent),
        TimeResource,
        CombatFxResource,
    ] as const,
    step(damage, movement, shipData, time, state) {
        const x = movement.position.x;
        const y = movement.position.y;
        const mass = shipData?.physics.mass ?? 120;
        const radius = Math.min(68, Math.max(25, Math.sqrt(mass) * 1.6));

        if (damage.shield > 0 && state.shieldFlares.length < 50) {
            state.shieldFlares.push({
                x,
                y,
                radius,
                startedAt: time.time,
                duration: 160,
            });
        }

        if (damage.armor > 0 && state.sparks.length < 150) {
            const sparkCount = Math.min(8, Math.max(3, Math.floor(damage.armor / 5) + 3));
            for (let i = 0; i < sparkCount; i++) {
                const angle = Math.random() * Math.PI * 2;
                const speed = 60 + Math.random() * 160;
                const isGold = Math.random() > 0.4;
                state.sparks.push({
                    x: x + (Math.random() - 0.5) * 16,
                    y: y + (Math.random() - 0.5) * 16,
                    vx: movement.velocity.x * 0.3 + Math.cos(angle) * speed,
                    vy: movement.velocity.y * 0.3 + Math.sin(angle) * speed,
                    color: isGold ? 0xffcc33 : 0xff5522,
                    startedAt: time.time,
                    duration: 140 + Math.random() * 80,
                });
            }
        }
    },
});

export const DisabledSmokeSystem = new System({
    name: 'DisabledSmokeSystem',
    args: [
        DisabledComponent,
        MovementStateComponent,
        TimeResource,
        CombatFxResource,
    ] as const,
    step(disabled, movement, time, state) {
        if (!disabled || state.smokePuffs.length >= 80) {
            return;
        }

        const now = time.time;
        const key = `${Math.round(movement.position.x / 100)},${Math.round(movement.position.y / 100)}`;
        const last = state.lastSmokeAt.get(key) ?? 0;
        if (now - last < 140) {
            return;
        }
        state.lastSmokeAt.set(key, now);

        // Drift behind ship velocity
        const speed = movement.velocity.length;
        const trailX = speed > 0 ? -movement.velocity.x / speed * 12 : 0;
        const trailY = speed > 0 ? -movement.velocity.y / speed * 12 : 0;

        state.smokePuffs.push({
            x: movement.position.x + trailX + (Math.random() - 0.5) * 8,
            y: movement.position.y + trailY + (Math.random() - 0.5) * 8,
            vx: movement.velocity.x * 0.15 + (Math.random() - 0.5) * 20,
            vy: movement.velocity.y * 0.15 + (Math.random() - 0.5) * 20,
            radius: 8 + Math.random() * 6,
            startedAt: now,
            duration: 380,
        });

        // Occasional electrical spark
        if (Math.random() < 0.35 && state.sparks.length < 150) {
            const angle = Math.random() * Math.PI * 2;
            state.sparks.push({
                x: movement.position.x + (Math.random() - 0.5) * 12,
                y: movement.position.y + (Math.random() - 0.5) * 12,
                vx: Math.cos(angle) * 70,
                vy: Math.sin(angle) * 70,
                color: 0x88eeff,
                startedAt: now,
                duration: 120,
            });
        }
    },
});

export const DrawCombatFxSystem = new System({
    name: 'DrawCombatFxSystem',
    after: [ClearCombatFx],
    args: [
        CombatFxGraphics,
        CombatFxResource,
        TimeResource,
        SingletonComponent,
    ] as const,
    step(graphicsHandle, state, time) {
        const g = graphicsHandle.root as PIXI.Graphics;
        const now = time.time;
        const dt = time.delta_s;

        // 1. Render Shield Flares
        let flareWrite = 0;
        for (let i = 0; i < state.shieldFlares.length; i++) {
            const flare = state.shieldFlares[i];
            const elapsed = now - flare.startedAt;
            if (elapsed >= flare.duration) {
                continue;
            }
            const progress = elapsed / flare.duration;
            const currentRadius = flare.radius * (1 + progress * 0.18);
            const alpha = (1 - progress) * 0.85;

            // Electric cyan/blue translucent shield bubble
            g.circle(flare.x, flare.y, currentRadius)
                .stroke({ width: 2.5 * (1 - progress), color: 0x88eeff, alpha });
            g.circle(flare.x, flare.y, currentRadius * 0.94)
                .fill({ color: 0x2277dd, alpha: alpha * 0.22 });

            state.shieldFlares[flareWrite++] = flare;
        }
        state.shieldFlares.length = flareWrite;

        // 2. Render Hull Sparks
        let sparkWrite = 0;
        for (let i = 0; i < state.sparks.length; i++) {
            const spark = state.sparks[i];
            const elapsed = now - spark.startedAt;
            if (elapsed >= spark.duration) {
                continue;
            }
            spark.x += spark.vx * dt;
            spark.y += spark.vy * dt;
            const progress = elapsed / spark.duration;
            const alpha = (1 - progress) * 0.95;

            g.circle(spark.x, spark.y, 1.8 * (1 - progress * 0.5))
                .fill({ color: spark.color, alpha });

            state.sparks[sparkWrite++] = spark;
        }
        state.sparks.length = sparkWrite;

        // 3. Render Smoke Puffs
        let smokeWrite = 0;
        for (let i = 0; i < state.smokePuffs.length; i++) {
            const smoke = state.smokePuffs[i];
            const elapsed = now - smoke.startedAt;
            if (elapsed >= smoke.duration) {
                continue;
            }
            smoke.x += smoke.vx * dt;
            smoke.y += smoke.vy * dt;
            const progress = elapsed / smoke.duration;
            const currentRadius = smoke.radius * (1 + progress * 1.2);
            const alpha = (1 - progress) * 0.32;

            g.circle(smoke.x, smoke.y, currentRadius)
                .fill({ color: 0x3a3a3a, alpha });

            state.smokePuffs[smokeWrite++] = smoke;
        }
        state.smokePuffs.length = smokeWrite;

        // Clean stale smoke spatial keys
        if (state.lastSmokeAt.size > 200) {
            state.lastSmokeAt.clear();
        }
    },
});

export const CombatFxPlugin: Plugin = {
    name: 'CombatFxPlugin',
    build(world) {
        const space = world.resources.get(Space);
        if (!space) {
            throw new Error('Expected space resource');
        }
        const graphics = new PIXI.Graphics();
        graphics.name = 'CombatFxGraphics';
        graphics.zIndex = 12;
        world.resources.set(CombatFxGraphics, attachGraphic(space, graphics));
        world.resources.set(CombatFxResource, new CombatFxState());

        world.addSystem(ClearCombatFx);
        world.addSystem(RecordDamageFxSystem);
        world.addSystem(DisabledSmokeSystem);
        world.addSystem(DrawCombatFxSystem);
    },
    remove(world) {
        world.removeSystem(DrawCombatFxSystem);
        world.removeSystem(DisabledSmokeSystem);
        world.removeSystem(RecordDamageFxSystem);
        world.removeSystem(ClearCombatFx);

        world.resources.get(CombatFxGraphics)?.dispose();
        world.resources.delete(CombatFxGraphics);
        world.resources.delete(CombatFxResource);
    },
};
