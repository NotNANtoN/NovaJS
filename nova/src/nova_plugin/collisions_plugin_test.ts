import 'jasmine';
import * as SAT from 'sat';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import RBush from 'rbush';
import {
    CollisionHitterComponent,
    CollisionVulnerabilityComponent,
    CollisionEvent,
} from './collision_interaction';
import {
    CollisionSystem,
    CompositeHull,
    hullFromAnimation,
    HurtboxHullComponent,
    HitboxHullComponent,
    RBushResource,
    UpdateHitboxHullSystem,
} from './collisions_plugin';
import { readResourceFork } from 'resource_fork';
import { RledResource } from 'novaparse/src/resource_parsers/RledResource';
import { SpriteSheetMultiParse } from 'novaparse/src/parsers/SpriteSheetMultiParse';
import { defaultIDSpace } from 'novaparse/test/resource_parsers/DefaultIDSpace';
import { fixturePath } from 'test/fixture_path';
import { getDefaultAnimation } from 'novadatainterface/Animation';
import { Position } from 'nova_ecs/datatypes/position';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Vector } from 'nova_ecs/datatypes/vector';

function triangle(): CompositeHull {
    return new CompositeHull([new SAT.Polygon(new SAT.Vector(), [
        new SAT.Vector(0, 0),
        new SAT.Vector(2, 0),
        new SAT.Vector(0, 2),
    ])]);
}

function makeWorld(hurtbox: CompositeHull, hitbox: CompositeHull) {
    const world = new World('collision-test');
    world.resources.set(RBushResource, new RBush());
    world.addSystem(CollisionSystem);
    world.entities.set('hitter', new Entity()
        .addComponent(HurtboxHullComponent, hurtbox)
        .addComponent(CollisionHitterComponent, { hitTypes: new Set(['laser']) }));
    world.entities.set('target', new Entity()
        .addComponent(HitboxHullComponent, hitbox)
        .addComponent(CollisionVulnerabilityComponent, {
            vulnerableTo: new Set(['laser']),
        }));
    return world;
}

describe('collision broad and narrow phases', () => {
    it('rejects broad-phase overlap when polygons do not collide', () => {
        const hurtbox = triangle();
        const hitbox = triangle();
        hitbox.pos = new SAT.Vector(1.1, 1.1);
        const world = makeWorld(hurtbox, hitbox);
        const collisions: unknown[] = [];
        world.events.get(CollisionEvent).subscribe(event => collisions.push(event));

        world.step();

        expect(collisions).toEqual([]);
    });

    it('emits a collision after the narrow phase confirms overlap', () => {
        const hurtbox = triangle();
        const hitbox = triangle();
        hitbox.pos = new SAT.Vector(0.5, 0.5);
        const world = makeWorld(hurtbox, hitbox);
        const collisions: unknown[] = [];
        world.events.get(CollisionEvent).subscribe(event => collisions.push(event));

        world.step();

        expect(collisions.length).toBe(2);
        expect(collisions).toContain({ other: 'target', initiator: true });
        expect(collisions).toContain({ other: 'hitter', initiator: false });
    });

    it('hits the generated Leviathan hull from every side and orientation',
        async () => {
            const resources = await readResourceFork(fixturePath(
                'novaparse/test/resource_parsers/files/rled.ndat'), false);
            const rled = new RledResource(resources.rlëD[1006], defaultIDSpace);
            rled.globalID = 'nova:1006';
            rled.prefix = 'nova';
            const parsed = await SpriteSheetMultiParse(rled, fail);
            const animation = getDefaultAnimation();
            animation.images.baseImage.id = rled.globalID;
            animation.images.baseImage.frames.normal = {
                start: 0,
                length: 64,
            };
            const gameData = {
                data: {
                    SpriteSheet: {
                        get: async () => parsed.spriteSheet,
                    },
                },
            };
            const leviathan = await hullFromAnimation(
                animation, gameData as never);

            const contactDistance = (
                xDirection: number,
                yDirection: number,
            ): number | undefined => {
                for (let distance = 100; distance >= 0; distance -= 0.5) {
                    const projectile = new CompositeHull([
                        new SAT.Circle(new SAT.Vector(), 2),
                    ]);
                    projectile.pos = new SAT.Vector(
                        xDirection * distance,
                        yDirection * distance,
                    );
                    if (leviathan.collides(projectile)) {
                        return distance;
                    }
                }
                return undefined;
            };

            for (const orientation of [
                0,
                Math.PI / 2,
                Math.PI,
                -Math.PI / 2,
                Math.PI / 7,
            ]) {
                UpdateHitboxHullSystem.step({
                    accelerating: 0,
                    position: new Position(0, 0),
                    rotation: new Angle(orientation),
                    turnBack: false,
                    turning: 0,
                    velocity: new Vector(0, 0),
                }, leviathan, animation);

                const contacts = [
                    contactDistance(-1, 0),
                    contactDistance(1, 0),
                    contactDistance(0, -1),
                    contactDistance(0, 1),
                ];
                expect(contacts.every(contact => contact !== undefined))
                    .withContext(`orientation ${orientation}`)
                    .toBe(true);
            }
        });
});
