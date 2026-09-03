import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import * as PIXI from 'pixi.js';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import {
    CloakStateComponent,
    CLOAK_TRANSITION_MS,
    CLOAKED_ALPHA,
} from '../nova_plugin/cloaking_plugin';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import { AnimationGraphicComponent, ObjectDrawSystem } from './animation_graphic_plugin';
import { Space } from './space_resource';
import { attachGraphic, ManagedGraphic } from './managed_graphic';

export const CloakWakeGraphics = new Resource<ManagedGraphic>('CloakWakeGraphics');

export const ClearCloakWakes = new System({
    name: 'ClearCloakWakes',
    args: [CloakWakeGraphics, SingletonComponent] as const,
    step(wakeHandle) {
        (wakeHandle.root as PIXI.Graphics).clear();
    },
});

export const CloakVisualSystem = new System({
    name: 'CloakVisualSystem',
    after: [ClearCloakWakes, ObjectDrawSystem],
    args: [
        MovementStateComponent,
        AnimationGraphicComponent,
        CloakStateComponent,
        Optional(PlayerShipSelector),
        TimeResource,
        Optional(CloakWakeGraphics),
    ] as const,
    step(movement, graphic, cloakState, playerShip, time, wakeHandle) {
        if (graphic.managed.disposed) {
            return;
        }

        const elapsed = Math.max(0, time.time - cloakState.transitionStartedAt);
        const inTransition = elapsed < CLOAK_TRANSITION_MS;
        const progress = Math.min(1, elapsed / CLOAK_TRANSITION_MS);

        if (wakeHandle && inTransition) {
            const wakeGraphics = wakeHandle.root as PIXI.Graphics;
            if (cloakState.cloaked) {
                // Engaging cloak: expanding holographic refraction ripples
                const rippleRadius = 12 + progress * 55;
                const alpha1 = (1 - progress) * 0.85;
                wakeGraphics.circle(movement.position.x, movement.position.y, rippleRadius)
                    .stroke({ width: 2 + (1 - progress) * 2, color: 0x44ddff, alpha: alpha1 });

                const innerRadius = 6 + progress * 28;
                const alpha2 = (1 - progress) * 0.95;
                wakeGraphics.circle(movement.position.x, movement.position.y, innerRadius)
                    .stroke({ width: 1.5, color: 0xaaeaff, alpha: alpha2 });

                // Cloak field distortion emitter arcs
                const arcLen = 14 * (1 - progress);
                wakeGraphics.ellipse(
                    movement.position.x,
                    movement.position.y,
                    rippleRadius * 0.8,
                    rippleRadius * 0.5,
                ).stroke({ width: 1, color: 0x88ffff, alpha: alpha1 * 0.7 });
            } else {
                // Decloaking: energy dissipation flare and collapsing field
                const burstRadius = 45 * progress;
                const alpha = (1 - progress) * 0.9;
                wakeGraphics.circle(movement.position.x, movement.position.y, burstRadius)
                    .stroke({ width: 2 + (1 - progress) * 2, color: 0x66ccff, alpha });

                const coreRadius = Math.max(2, 18 * (1 - progress));
                wakeGraphics.circle(movement.position.x, movement.position.y, coreRadius)
                    .stroke({ width: 1.5, color: 0xffffff, alpha: (1 - progress) * 0.8 });
            }
        }

        if (playerShip) {
            if (cloakState.cloaked) {
                // The player's own ship remains visible as an active holographic ghost hull
                const stealthPulse = 0.20 + 0.05 * Math.sin(time.time * 0.005);
                graphic.container.alpha = inTransition
                    ? Math.max(0.2, cloakState.alpha)
                    : stealthPulse;

                // Faint tactical sensor outline for player navigation in deep space
                if (wakeHandle && !inTransition) {
                    const wakeGraphics = wakeHandle.root as PIXI.Graphics;
                    const haloAlpha = 0.10 + 0.04 * Math.sin(time.time * 0.005);
                    wakeGraphics.circle(movement.position.x, movement.position.y, 22)
                        .stroke({ width: 1, color: 0x3399cc, alpha: haloAlpha });
                }
            } else {
                graphic.container.alpha = inTransition ? cloakState.alpha : 1.0;
            }
        } else {
            // Remote / NPC vessels
            if (cloakState.cloaked) {
                if (inTransition) {
                    graphic.container.alpha = Math.max(
                        0,
                        (cloakState.alpha - CLOAKED_ALPHA) / (1 - CLOAKED_ALPHA),
                    );
                } else {
                    graphic.container.alpha = 0;
                }
            } else {
                graphic.container.alpha = inTransition
                    ? (cloakState.alpha - CLOAKED_ALPHA) / (1 - CLOAKED_ALPHA)
                    : 1.0;
            }
        }
    },
});

export const CloakEffectPlugin: Plugin = {
    name: 'CloakEffectPlugin',
    build(world) {
        const space = world.resources.get(Space);
        if (!space) {
            throw new Error('Expected space resource');
        }
        const wakeGraphics = new PIXI.Graphics();
        wakeGraphics.name = 'CloakWakeGraphics';
        wakeGraphics.zIndex = 8.5;
        world.resources.set(CloakWakeGraphics, attachGraphic(space, wakeGraphics));
        world.addSystem(ClearCloakWakes);
        world.addSystem(CloakVisualSystem);
    },
    remove(world) {
        world.resources.get(CloakWakeGraphics)?.dispose();
        world.removeSystem(CloakVisualSystem);
        world.removeSystem(ClearCloakWakes);
        world.resources.delete(CloakWakeGraphics);
    },
};
