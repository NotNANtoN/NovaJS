import { Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { AddEvent, DeleteEvent } from "nova_ecs/events";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent, MovementSystem } from "nova_ecs/plugins/movement_plugin";
import { Provide } from "nova_ecs/provide";
import { originalIfDraft, ProvideAsync } from "nova_ecs/provide_async";
import { System } from "nova_ecs/system";
import * as PIXI from "pixi.js";
import { DisplayAssetDataResource } from "../nova_plugin/game_data_resource.js";
import { currentIfDraft } from "../util/deimmerify.js";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { AnimationComponent, TumbleAnimationComponent } from "../nova_plugin/animation_plugin.js";
import { AsteroidComponent, DebrisComponent } from "../nova_plugin/asteroid_plugin.js";
import { PlanetComponent } from "../nova_plugin/planet_plugin.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";
import { ProjectileComponent } from "../nova_plugin/projectile_data.js";
import { ShipComponent } from "../nova_plugin/ship_plugin.js";
import { AnimationGraphic } from "./animation_graphic.js";
import { AnimationGraphicPool, AnimationGraphicPoolResource } from "./animation_graphic_pool.js";
import { Space } from "./space_resource.js";

export const AnimationGraphicComponent = new Component<AnimationGraphic>('AnimationGraphic');
const AnimationGraphicLoadedComponent = new Component<AnimationGraphic>('AnimationGraphicLoaded');
const AnimationGraphicLoader = ProvideAsync({
    name: "AnimationGraphicLoader",
    provided: AnimationGraphicLoadedComponent,
    args: [AnimationComponent, DisplayAssetDataResource, GetEntity,
        AnimationGraphicPoolResource] as const,
    async factory(animation, displayAssets, entity, poolResource) {
        const pool = originalIfDraft(poolResource);
        const currentAnimation = currentIfDraft(animation)!;

        // Reuse a pooled graphic if one is available. Otherwise, build a
        // new one, which allocates PIXI display objects.
        let graphic = pool.acquire(currentAnimation);
        if (graphic) {
            graphic.reset();
        } else {
            graphic = new AnimationGraphic({
                displayAssets: currentIfDraft(displayAssets)!,
                animation: currentAnimation,
            });
            await graphic.buildPromise;
        }

        // Move the graphic to the entity's position before it becomes
        // visible so a reused graphic does not flash at the position where
        // its previous entity died.
        const movement = entity.components.get(MovementStateComponent);
        if (movement) {
            graphic.container.position.x = movement.position.x;
            graphic.container.position.y = movement.position.y;
            graphic.rotation = movement.rotation.angle;
        }

        // Order sprites
        if (entity.components.has(PlayerShipSelector)) {
            graphic.container.zIndex = 10;
        } else if (entity.components.has(ProjectileComponent)) {
            // TODO: Support projectiles above and below ships.
            graphic.container.zIndex = 9;
        } else if (entity.components.has(ShipComponent)) {
            graphic.container.zIndex = 8;
        } else if (entity.components.has(AsteroidComponent)) {
            graphic.container.zIndex = 7;
        } else if (entity.components.has(DebrisComponent)) {
            graphic.container.zIndex = 6;
        } else if (entity.components.has(PlanetComponent)) {
            graphic.container.zIndex = -10;
        }

        return graphic;
    }
});

// Attaches a graphic to the space container and makes it visible. Pooled
// graphics stay attached (hidden) to the space container when their entity
// dies, so skip addChild for them to avoid removeChild/addChild splicing.
function attachGraphic(graphic: AnimationGraphic, space: PIXI.Container) {
    if (graphic.container.parent !== space) {
        space.addChild(graphic.container);
    }
    graphic.container.visible = true;
}

// Add the graphic to the PIXI container in a synchronous system. Othewise,
// the check that makes sure the entity is still in the world may be
// invalid.
export const AnimationGraphicProvider = Provide({
    name: "AnimationGraphicProvider",
    provided: AnimationGraphicComponent,
    args: [AnimationGraphicLoadedComponent, Space, Entities, UUID] as const,
    factory(graphic, space, entities, uuid) {
        // Only add the graphic to the container if the entity still exists
        if (entities.has(uuid)) {
            attachGraphic(graphic, space);
        } else {
            console.log(`Not adding graphic for ${uuid} since it is no longer in the system`);
            // The graphic may be a pooled one that is still attached to the
            // space container. Detach it since nothing will clean it up.
            space.removeChild(graphic.container);
        }
        return graphic;
    }
});

export const ObjectDrawSystem = new System({
    name: "ObjectDrawSystem",
    args: [MovementStateComponent, AnimationGraphicComponent] as const,
    step: (movementState, graphic) => {
        if (movementState.turning < 0) {
            graphic.setFramesToUse('left');
        } else if (movementState.turning > 0) {
            graphic.setFramesToUse('right');
        } else {
            graphic.setFramesToUse('normal');
        }

        graphic.glowAlpha = movementState.accelerating *
            (1 - (Math.random() * 0.2));

        graphic.container.position.x = movementState.position.x;
        graphic.container.position.y = movementState.position.y;
        graphic.rotation = movementState.rotation.angle;
    },
    after: [MovementSystem],
});

/**
 * Draws entities whose sprite frames are a pre-rendered animation (3D
 * asteroid tumbles, spinning weapon graphics) rather than view
 * rotations. Frames advance at TumbleAnimation.frameRate on logical
 * time; the entity's sim rotation is deliberately ignored — mapping it
 * to a frame or applying it as a screen-space sprite rotation (what
 * ObjectDrawSystem does, correct for ships) would compose two
 * unrelated rotations. Runs after ObjectDrawSystem to override it.
 * See TumbleAnimationComponent for the wëap/shän flags of future
 * consumers.
 */
export const TumbleDrawSystem = new System({
    name: 'TumbleDrawSystem',
    args: [TumbleAnimationComponent, AnimationGraphicComponent,
        TimeResource] as const,
    step(tumble, graphic, time) {
        const seconds = time.time / 1000;
        for (const sprite of graphic.sprites.values()) {
            if (sprite.frames <= 0) {
                continue; // Textures still loading.
            }
            const cycles = tumble.phase
                + seconds * tumble.frameRate / sprite.frames;
            const phase = ((cycles % 1) + 1) % 1;
            sprite.frame = Math.min(sprite.frames - 1,
                Math.floor(phase * sprite.frames));
            sprite.pixiSprite.rotation = 0;
        }
    },
    after: [ObjectDrawSystem],
});

const AnimationGraphicCleanup = new System({
    name: 'AnimationGraphicCleanup',
    events: [DeleteEvent],
    args: [AnimationGraphicComponent, Optional(AnimationComponent),
        AnimationGraphicPoolResource, Space] as const,
    step: (graphic, animation, pool, space) => {
        if (animation && pool.release(currentIfDraft(animation), graphic)) {
            // Keep the graphic attached to the space container but hidden so
            // that reusing it does not pay for removeChild / addChild, which
            // splice the container's children array.
            graphic.container.visible = false;
        } else {
            space.removeChild(graphic.container);
        }
    }
});

const AnimationGraphicInsert = new System({
    name: 'AnimationGraphicInsert',
    events: [AddEvent],
    args: [AnimationGraphicComponent, Space] as const,
    step(graphic, space) {
        attachGraphic(graphic, space);
    }
});

export const AnimationGraphicPlugin: Plugin = {
    name: 'AnimationGraphicPlugin',
    build(world) {
        world.resources.set(AnimationGraphicPoolResource,
            new AnimationGraphicPool());
        world.addSystem(AnimationGraphicLoader);
        world.addSystem(AnimationGraphicProvider);
        world.addSystem(ObjectDrawSystem);
        world.addSystem(TumbleDrawSystem);
        world.addSystem(AnimationGraphicCleanup);
        world.addSystem(AnimationGraphicInsert);
    },
    remove(world) {
        world.removeSystem(AnimationGraphicLoader);
        world.removeSystem(AnimationGraphicProvider);
        world.removeSystem(ObjectDrawSystem);
        world.removeSystem(TumbleDrawSystem);
        world.removeSystem(AnimationGraphicCleanup);
        world.removeSystem(AnimationGraphicInsert);
        world.resources.delete(AnimationGraphicPoolResource);
    }
}
