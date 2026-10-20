import * as t from 'io-ts';
import { replicationPolicies } from "nova_ecs/plugins/multiplayer_plugin";
import { Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { AddEvent, DeleteEvent } from "nova_ecs/events";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import {
    MovementStateComponent,
    MovementSystem,
    RemoteMovementPresentationSystem,
} from "nova_ecs/plugins/movement_plugin";
import { Provide } from "nova_ecs/provide";
import { ProvideAsync } from "nova_ecs/provide_async";
import { System } from "nova_ecs/system";
import { currentIfDraft } from "../util/deimmerify";
import { AnimationComponent, ExplosionDataComponent } from "../nova_plugin/animation_plugin";
import { GameDataResource } from "../nova_plugin/game_data_resource";
import { PlanetComponent } from "../nova_plugin/planet_plugin";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin";
import { ProjectileComponent } from "../nova_plugin/projectile_data";
import { ReturnToQueueComponent } from "../nova_plugin/return_to_queue_plugin";
import { ShipComponent } from "../nova_plugin/ship_plugin";
import { CloakStateComponent, CLOAKED_ALPHA } from "../nova_plugin/cloaking_plugin";
import { AsteroidTumbleSystem, OreTumbleSystem } from "../nova_plugin/asteroid_plugin";
import { AnimationGraphic } from "./animation_graphic";
import { FireLogSpawnSystem } from '../nova_plugin/weapon_plugin';
import { Space } from "./space_resource";

export const AnimationGraphicComponent = new Component<AnimationGraphic>('AnimationGraphic');
export const AnimationGraphicLoadedComponent = new Component<AnimationGraphic>('AnimationGraphicLoaded');
replicationPolicies.register(AnimationGraphicComponent, { codec: t.any, authority: 'local-only' });
replicationPolicies.register(AnimationGraphicLoadedComponent, { codec: t.any, authority: 'local-only' });
/** The animation a graphic was built from, to notice a hull change. */
const builtFrom = new WeakMap<AnimationGraphic, string>();
const cachedAnimationKeys = new WeakMap<object, string>();

function animationKey(animation: { id?: string, images?: unknown }): string {
    const cached = cachedAnimationKeys.get(animation);
    if (cached !== undefined) {
        return cached;
    }
    const key = `${animation.id ?? ''}|${JSON.stringify(animation.images ?? {})}`;
    cachedAnimationKeys.set(animation, key);
    return key;
}

const MAX_POOLED_EXPLOSION_GRAPHICS_PER_KEY = 24;
const explosionGraphicPool = new Map<string, AnimationGraphic[]>();

function takePooledExplosionGraphic(key: string): AnimationGraphic | undefined {
    const bucket = explosionGraphicPool.get(key);
    while (bucket && bucket.length > 0) {
        const candidate = bucket.pop()!;
        if (!candidate.managed.disposed && candidate.built) {
            candidate.progress = 0;
            candidate.container.alpha = 1;
            candidate.container.zIndex = 12;
            return candidate;
        }
    }
    return undefined;
}

function releaseExplosionGraphicToPool(key: string, graphic: AnimationGraphic): boolean {
    if (graphic.managed.disposed || !graphic.built) {
        return false;
    }
    let bucket = explosionGraphicPool.get(key);
    if (!bucket) {
        bucket = [];
        explosionGraphicPool.set(key, bucket);
    }
    if (bucket.length >= MAX_POOLED_EXPLOSION_GRAPHICS_PER_KEY) {
        return false;
    }
    graphic.detach();
    graphic.progress = 0;
    bucket.push(graphic);
    return true;
}

function clearExplosionGraphicPool(): void {
    for (const bucket of explosionGraphicPool.values()) {
        for (const graphic of bucket) {
            if (!graphic.managed.disposed) {
                graphic.dispose();
            }
        }
    }
    explosionGraphicPool.clear();
}

const AnimationGraphicLoader = ProvideAsync({
    name: "AnimationGraphicLoader",
    provided: AnimationGraphicLoadedComponent,
    args: [AnimationComponent, GameDataResource, GetEntity, Optional(AnimationGraphicComponent)] as const,
    // A new hull (shipyard purchase, commandeered ship) swaps the animation
    // in flight; the sprite must follow instead of waiting for a relanding.
    update: [AnimationComponent],
    dispose: graphic => graphic.dispose(),
    async factory(animation, gameData, entity, existingGraphic) {
        const key = animationKey(currentIfDraft(animation)!);
        if (existingGraphic && !existingGraphic.managed.disposed
            && (builtFrom.get(existingGraphic) ?? key) === key) {
            builtFrom.set(existingGraphic, key);
            return existingGraphic;
        }
        const graphic = new AnimationGraphic({
            gameData: currentIfDraft(gameData)!,
            animation: currentIfDraft(animation)!,
        });
        builtFrom.set(graphic, key);
        await graphic.buildPromise;

        // Order sprites
        if (entity.components.has(ExplosionDataComponent)) {
            graphic.container.zIndex = 12;
        } else if (entity.components.has(PlayerShipSelector)) {
            graphic.container.zIndex = 10;
        } else if (entity.components.has(ProjectileComponent)) {
            // TODO: Support projectiles above and below ships.
            graphic.container.zIndex = 9;
        } else if (entity.components.has(ShipComponent)) {
            graphic.container.zIndex = 8;
        } else if (entity.components.has(PlanetComponent)) {
            graphic.container.zIndex = -10;
        }

        return graphic;
    }
});

// Add the graphic to the PIXI container in a synchronous system. Othewise,
// the check that makes sure the entity is still in the world may be
// invalid.
export const AnimationGraphicProvider = Provide({
    name: "AnimationGraphicProvider",
    provided: AnimationGraphicComponent,
    args: [AnimationGraphicLoadedComponent, Space, Entities, UUID, Optional(ReturnToQueueComponent), Optional(AnimationGraphicComponent)] as const,
    factory(graphic, space, entities, uuid, recyclable, existingGraphic) {
        if (existingGraphic && existingGraphic !== graphic) {
            if (recyclable) {
                existingGraphic.detach();
            } else {
                existingGraphic.dispose();
            }
        }
        // Only add the graphic to the container if the entity still exists
        if (entities.has(uuid)) {
            graphic.attachTo(space);
        } else {
            if (recyclable) {
                graphic.detach();
            } else {
                graphic.dispose();
            }
            console.log(`Not adding graphic for ${uuid} since it is no longer in the system`);
        }
        return graphic;
    }
});

export const ObjectDrawSystem = new System({
    name: "ObjectDrawSystem",
    args: [MovementStateComponent, AnimationGraphicComponent, Optional(CloakStateComponent), Optional(PlayerShipSelector), Optional(ExplosionDataComponent)] as const,
    step: (movementState, graphic, cloakState, playerShip, explosionData) => {
        if (graphic.managed.disposed) {
            // Cleanup already destroyed this graphic (entity deleted); a
            // straggler step must not touch the freed Pixi transform.
            return;
        }
        if (explosionData) {
            // Explosions step their frame via `graphic.progress` in ExplosionSystem.
            // Setting `graphic.rotation` here would overwrite `sprite.frame` back to 0!
            graphic.container.alpha = 1;
            graphic.container.position.x = movementState.position.x;
            graphic.container.position.y = movementState.position.y;
            return;
        }
        if (movementState.turning < 0) {
            graphic.setFramesToUse('left');
        } else if (movementState.turning > 0) {
            graphic.setFramesToUse('right');
        } else {
            graphic.setFramesToUse('normal');
        }

        graphic.glowAlpha = movementState.accelerating *
            (1 - (Math.random() * 0.2));

        if (cloakState) {
            if (playerShip) {
                // The player's own ship is rendered as a semi-transparent ghost hull
                graphic.container.alpha = Math.max(0.2, cloakState.alpha);
            } else {
                // Remote and NPC ships fade completely invisible when fully cloaked
                if (cloakState.cloaked && cloakState.alpha <= CLOAKED_ALPHA + 0.01) {
                    graphic.container.alpha = 0;
                } else {
                    // Shimmering optical refraction during transition
                    graphic.container.alpha = Math.max(0, (cloakState.alpha - CLOAKED_ALPHA) / (1 - CLOAKED_ALPHA));
                }
            }
        } else {
            graphic.container.alpha = 1;
        }

        graphic.container.position.x = movementState.position.x;
        graphic.container.position.y = movementState.position.y;
        graphic.rotation = movementState.rotation.angle;
    },
    after: [MovementSystem, RemoteMovementPresentationSystem, FireLogSpawnSystem, AsteroidTumbleSystem, OreTumbleSystem],
});

const AnimationGraphicCleanup = new System({
    name: 'AnimationGraphicCleanup',
    events: [DeleteEvent],
    args: [AnimationGraphicComponent, Optional(ReturnToQueueComponent),
        Space, GetEntity] as const,
    step: (graphic, recyclable, _space, entity) => {
        if (recyclable) {
            // Projectiles are pooled: the same Entity (and therefore the same
            // AnimationGraphic) is reused for the next shot. Destroying the
            // Pixi subtree here would leave every later shot simulated,
            // audible, and collidable, but never drawn.
            graphic.detach();
            return;
        }
        const key = builtFrom.get(graphic);
        if (entity.components.has(ExplosionDataComponent) && key && releaseExplosionGraphicToPool(key, graphic)) {
            entity.components.delete(AnimationGraphicComponent);
            entity.components.delete(AnimationGraphicLoadedComponent);
            return;
        }
        graphic.dispose();
        entity.components.delete(AnimationGraphicComponent);
        entity.components.delete(AnimationGraphicLoadedComponent);
    }
});

const SyncAnimationGraphicInsert = new System({
    name: 'SyncAnimationGraphicInsert',
    events: [AddEvent],
    args: [AnimationComponent, GameDataResource, Space, Optional(MovementStateComponent), GetEntity, Optional(AnimationGraphicComponent)] as const,
    step(animation, gameData, space, movementState, entity, existingGraphic) {
        if (existingGraphic && !existingGraphic.managed.disposed) {
            existingGraphic.attachTo(space);
            if (movementState) {
                existingGraphic.container.position.x = movementState.position.x;
                existingGraphic.container.position.y = movementState.position.y;
                existingGraphic.rotation = movementState.rotation.angle;
            }
            return;
        }

        if (existingGraphic && existingGraphic.managed.disposed) {
            entity.components.delete(AnimationGraphicComponent);
            entity.components.delete(AnimationGraphicLoadedComponent);
        }

        const anim = currentIfDraft(animation)!;
        const key = animationKey(anim);
        const isExplosion = entity.components.has(ExplosionDataComponent);
        const pooled = isExplosion ? takePooledExplosionGraphic(key) : undefined;
        const graphic = pooled ?? new AnimationGraphic({
            gameData: currentIfDraft(gameData)!,
            animation: anim,
        });

        // Order sprites
        if (isExplosion) {
            graphic.container.zIndex = 12;
        } else if (entity.components.has(PlayerShipSelector)) {
            graphic.container.zIndex = 10;
        } else if (entity.components.has(ProjectileComponent)) {
            graphic.container.zIndex = 9;
        } else if (entity.components.has(ShipComponent)) {
            graphic.container.zIndex = 8;
        } else if (entity.components.has(PlanetComponent)) {
            graphic.container.zIndex = -10;
        }

        builtFrom.set(graphic, key);
        graphic.attachTo(space);
        if (movementState) {
            graphic.container.position.x = movementState.position.x;
            graphic.container.position.y = movementState.position.y;
            if (!isExplosion) {
                graphic.rotation = movementState.rotation.angle;
            }
        }
        entity.components.set(AnimationGraphicComponent, graphic);
        entity.components.set(AnimationGraphicLoadedComponent, graphic);
        if (!pooled) {
            void graphic.buildPromise.catch(error => {
                console.warn('Failed to build flight graphic', error);
                graphic.dispose();
            });
        }
    }
});

export const AnimationGraphicPlugin: Plugin = {
    name: 'AnimationGraphicPlugin',
    build(world) {
        world.addSystem(SyncAnimationGraphicInsert);
        world.addSystem(AnimationGraphicLoader);
        world.addSystem(AnimationGraphicProvider);
        world.addSystem(ObjectDrawSystem);
        world.addSystem(AnimationGraphicCleanup);
    },
    remove(world) {
        clearExplosionGraphicPool();
        world.removeSystem(SyncAnimationGraphicInsert);
        world.removeSystem(AnimationGraphicLoader);
        world.removeSystem(AnimationGraphicProvider);
        world.removeSystem(ObjectDrawSystem);
        world.removeSystem(AnimationGraphicCleanup);
    }
}
