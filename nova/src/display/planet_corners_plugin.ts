import { Entities } from 'nova_ecs/arg_types';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Resource } from "nova_ecs/resource";
import { System } from 'nova_ecs/system';
import { GameData } from '../client/gamedata/GameData';
import { GameDataResource } from '../nova_plugin/game_data_resource';
import { PlanetComponent, PlanetDataComponent, PlanetTargetComponent } from '../nova_plugin/planet_plugin';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import { AnimationGraphicComponent, ObjectDrawSystem } from './animation_graphic_plugin';
import { StatusBarResource } from './status_bar';
import { Space } from './space_resource';
import { TargetCorners } from "./target_corners_plugin";


const PlanetCornersResource = new Resource<TargetCorners>('PlanetCornersResource');

const DrawPlanetCornersSystem = new System({
    name: "DrawPlanetCornersSystem",
    args: [
        PlanetTargetComponent,
        TimeResource,
        PlanetCornersResource,
        Entities,
        PlayerShipSelector,
        Optional(MovementStateComponent),
        Optional(StatusBarResource),
    ] as const,
    step({ target }, time, targetCorners, entities, _player, playerMovement, statusBar) {
        if (!target) {
            targetCorners.visible = false;
            targetCorners.targetUuid = undefined;
            return;
        }

        const planetEntity = entities.get(target);
        if (!planetEntity) {
            targetCorners.visible = false;
            targetCorners.targetUuid = undefined;
            return;
        }

        const planetComponent = planetEntity.components.get(PlanetComponent);
        const planetData = planetEntity.components.get(PlanetDataComponent);
        const targetMovement = planetEntity.components.get(MovementStateComponent);
        const targetGraphic = planetEntity.components.get(AnimationGraphicComponent);

        if (!targetMovement && !targetGraphic) {
            targetCorners.visible = false;
            targetCorners.targetUuid = undefined;
            return;
        }

        const pos = targetGraphic ? targetGraphic.container.position : targetMovement!.position;
        const size = targetGraphic?.size ?? (planetData?.size ? { x: planetData.size, y: planetData.size } : { x: 72, y: 72 });
        const name = planetComponent?.name ?? planetData?.name ?? 'Stellar Object';

        targetCorners.setStyle("neutral");
        targetCorners.setPosition(pos);
        targetCorners.step(time.time, target, size, name,
            playerMovement?.position, {
                width: typeof window !== 'undefined' ? window.innerWidth : 1280,
                height: typeof window !== 'undefined' ? window.innerHeight : 720,
                statusBarWidth: statusBar?.width ?? 0,
            });
        targetCorners.visible = true;
    },
    after: [ObjectDrawSystem],
});

export const PlanetCornersPlugin: Plugin = {
    name: 'PlanetCornersPlugin',
    build(world) {
        const gameData = world.resources.get(GameDataResource);
        if (!gameData) {
            throw new Error('Expected world to have gameData');
        }

        const space = world.resources.get(Space);
        if (!space) {
            throw new Error('Expected world to have Space resource');
        }

        const targetCorners = new TargetCorners(gameData as GameData, 'planetCorners');
        targetCorners.attachTo(space);
        world.resources.set(PlanetCornersResource, targetCorners);
        world.addSystem(DrawPlanetCornersSystem);
    },
    remove(world) {
        const targetCorners = world.resources.get(PlanetCornersResource);
        if (targetCorners) {
            targetCorners.dispose();
        }
        world.removeSystem(DrawPlanetCornersSystem);
        world.resources.delete(PlanetCornersResource);
    }
}

