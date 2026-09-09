import 'jasmine';
import * as PIXI from 'pixi.js';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementStateComponent, MovementPlugin } from 'nova_ecs/plugins/movement_plugin';
import { TimePlugin, TimeResource } from 'nova_ecs/plugins/time_plugin';
import { getDefaultAnimation } from 'novadatainterface/Animation';
import { GameDataResource } from '../nova_plugin/game_data_resource';
import { AnimationComponent } from '../nova_plugin/animation_plugin';
import { Space } from './space_resource';
import { Stage } from './stage_resource';
import { AnimationGraphicComponent, AnimationGraphicPlugin } from './animation_graphic_plugin';
import { AnimationGraphic } from './animation_graphic';

describe('animation graphic lifecycle', () => {
    let world: World;
    let space: PIXI.Container;
    let stage: PIXI.Container;

    beforeEach(async () => {
        spyOn(PIXI.Assets, 'load').and.callFake(async () => PIXI.Texture.WHITE);
        world = new World('animation-graphic-test');
        stage = new PIXI.Container();
        space = new PIXI.Container();
        stage.addChild(space);
        world.resources.set(Stage, stage);
        world.resources.set(Space, space);
        world.resources.set(TimeResource, { time: 0, delta_ms: 16, delta_s: 0.016, frame: 0 });
        world.resources.set(GameDataResource, {
            data: {
                SpriteSheetFrames: { get: async () => ({ frames: {}, meta: { image: 'test.png' } }) },
            },
        } as never);
        world.addPlugin(TimePlugin);
        world.addPlugin(MovementPlugin);
        await world.addPlugin(AnimationGraphicPlugin);
    });

    it('does not duplicate graphics or leave an orphaned container at spawn coordinates', async () => {
        const entity = new Entity('ship')
            .addComponent(AnimationComponent, getDefaultAnimation())
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0), rotation: new Angle(0),
                velocity: new Vector(100, 0), accelerating: 0, turning: 0, turnBack: false,
            });
        world.entities.set('ship-1', entity);
        world.step();
        for (let i = 0; i < 10; i++) await Promise.resolve();
        world.step();

        const initialGraphic = entity.components.get(AnimationGraphicComponent)!;
        expect(initialGraphic).toBeDefined();
        expect(space.children).toContain(initialGraphic.container);

        // Move the ship
        entity.components.get(MovementStateComponent)!.position = new Position(500, 200);
        world.step();
        for (let i = 0; i < 10; i++) await Promise.resolve();
        world.step();

        // Exactly one container for this entity must exist in Space, at current coordinates
        const shipContainers = space.children.filter(c => c === initialGraphic.container);
        expect(shipContainers.length).toBe(1);
        expect(shipContainers[0].position.x).toBe(500);
        expect(shipContainers[0].position.y).toBe(200);

        // No orphaned container remains at the spawn position (0, 0)
        const orphanAtOrigin = space.children.find(c => c !== initialGraphic.container && c.position.x === 0 && c.position.y === 0);
        expect(orphanAtOrigin).toBeUndefined();
    });

    it('disposes and detaches the old container if a graphic is ever replaced', () => {
        const oldGraphic = new AnimationGraphic({
            gameData: world.resources.get(GameDataResource)!,
            animation: getDefaultAnimation(),
        });
        oldGraphic.attachTo(space);
        expect(space.children).toContain(oldGraphic.container);

        const entity = new Entity('ship')
            .addComponent(AnimationComponent, getDefaultAnimation())
            .addComponent(AnimationGraphicComponent, oldGraphic);
        world.entities.set('ship-2', entity);

        const newGraphic = new AnimationGraphic({
            gameData: world.resources.get(GameDataResource)!,
            animation: getDefaultAnimation(),
        });
        entity.components.set(AnimationGraphicComponent, newGraphic);
        newGraphic.attachTo(space);

        // Disposing old graphic removes it from space
        oldGraphic.dispose();
        expect(space.children).not.toContain(oldGraphic.container);
        expect(space.children).toContain(newGraphic.container);
    });

    it('cleans up graphics when an entity is replaced under the same uuid', () => {
        const first = new Entity('first')
            .addComponent(AnimationComponent, getDefaultAnimation())
            .addComponent(MovementStateComponent, {
                position: new Position(10, 20), rotation: new Angle(0),
                velocity: new Vector(0, 0), accelerating: 0, turning: 0, turnBack: false,
            });
        world.entities.set('uuid-1', first);
        world.step();
        const graphic = first.components.get(AnimationGraphicComponent)!;
        expect(space.children).toContain(graphic.container);

        // Replace entity under same uuid
        const second = new Entity('second')
            .addComponent(MovementStateComponent, {
                position: new Position(100, 200), rotation: new Angle(0),
                velocity: new Vector(0, 0), accelerating: 0, turning: 0, turnBack: false,
            });
        world.entities.set('uuid-1', second);
        world.step();

        // The replaced entity's graphic was cleaned up
        expect(space.children).not.toContain(graphic.container);
    });
});
