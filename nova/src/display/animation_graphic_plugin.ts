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
import { AnimationComponent } from "../nova_plugin/animation_plugin";
import { GameDataResource } from "../nova_plugin/game_data_resource";
import { PlanetComponent } from "../nova_plugin/planet_plugin";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin";
import { ProjectileComponent } from "../nova_plugin/projectile_data";
import { ReturnToQueueComponent } from "../nova_plugin/return_to_queue_plugin";
import { ShipComponent } from "../nova_plugin/ship_plugin";
import { AnimationGraphic } from "./animation_graphic";
import { Space } from "./space_resource";

export const AnimationGraphicComponent = new Component<AnimationGraphic>('AnimationGraphic');
const AnimationGraphicLoadedComponent = new Component<AnimationGraphic>('AnimationGraphicLoaded');
const AnimationGraphicLoader = ProvideAsync({
    name: "AnimationGraphicLoader",
    provided: AnimationGraphicLoadedComponent,
    args: [AnimationComponent, GameDataResource, GetEntity] as const,
    dispose: graphic => graphic.dispose(),
    async factory(animation, gameData, entity) {
        const graphic = new AnimationGraphic({
            gameData: currentIfDraft(gameData)!,
            animation: currentIfDraft(animation)!,
        });
        await graphic.buildPromise;

        // Order sprites
        if (entity.components.has(PlayerShipSelector)) {
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
    args: [AnimationGraphicLoadedComponent, Space, Entities, UUID, Optional(ReturnToQueueComponent)] as const,
    factory(graphic, space, entities, uuid, recyclable) {
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
    args: [MovementStateComponent, AnimationGraphicComponent] as const,
    step: (movementState, graphic) => {
        if (graphic.managed.disposed) {
            // Cleanup already destroyed this graphic (entity deleted); a
            // straggler step must not touch the freed Pixi transform.
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

        graphic.container.position.x = movementState.position.x;
        graphic.container.position.y = movementState.position.y;
        graphic.rotation = movementState.rotation.angle;
    },
    after: [MovementSystem, RemoteMovementPresentationSystem],
});

const AnimationGraphicCleanup = new System({
    name: 'AnimationGraphicCleanup',
    events: [DeleteEvent],
    args: [AnimationGraphicComponent, Optional(ReturnToQueueComponent),
        Space] as const,
    step: (graphic, recyclable) => {
        if (recyclable) {
            // Projectiles are pooled: the same Entity (and therefore the same
            // AnimationGraphic) is reused for the next shot. Destroying the
            // Pixi subtree here would leave every later shot simulated,
            // audible, and collidable, but never drawn.
            graphic.detach();
            return;
        }
        graphic.dispose();
    }
});

const SyncAnimationGraphicInsert = new System({
    name: 'SyncAnimationGraphicInsert',
    events: [AddEvent],
    args: [AnimationComponent, GameDataResource, Space, MovementStateComponent, GetEntity, Optional(AnimationGraphicComponent)] as const,
    step(animation, gameData, space, movementState, entity, existingGraphic) {
        if (existingGraphic) {
            if (!existingGraphic.managed.disposed) {
                existingGraphic.attachTo(space);
                existingGraphic.container.position.x = movementState.position.x;
                existingGraphic.container.position.y = movementState.position.y;
                existingGraphic.rotation = movementState.rotation.angle;
            }
            return;
        }

        const graphic = new AnimationGraphic({
            gameData: currentIfDraft(gameData)!,
            animation: currentIfDraft(animation)!,
        });

        // Order sprites
        if (entity.components.has(PlayerShipSelector)) {
            graphic.container.zIndex = 10;
        } else if (entity.components.has(ProjectileComponent)) {
            graphic.container.zIndex = 9;
        } else if (entity.components.has(ShipComponent)) {
            graphic.container.zIndex = 8;
        } else if (entity.components.has(PlanetComponent)) {
            graphic.container.zIndex = -10;
        }

        graphic.attachTo(space);
        graphic.container.position.x = movementState.position.x;
        graphic.container.position.y = movementState.position.y;
        graphic.rotation = movementState.rotation.angle;
        entity.components.set(AnimationGraphicComponent, graphic);
        entity.components.set(AnimationGraphicLoadedComponent, graphic);

        if ((globalThis as any).debugCombat || (globalThis as any).novaDebug?.debugCombat) {
            console.log(`[Combat Visual] Attached sprite for entity ${entity.name ?? 'projectile'} at (${Math.round(movementState.position.x)}, ${Math.round(movementState.position.y)}) rot=${movementState.rotation.angle.toFixed(2)}`);
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
        world.removeSystem(SyncAnimationGraphicInsert);
        world.removeSystem(AnimationGraphicLoader);
        world.removeSystem(AnimationGraphicProvider);
        world.removeSystem(ObjectDrawSystem);
        world.removeSystem(AnimationGraphicCleanup);
    }
}
