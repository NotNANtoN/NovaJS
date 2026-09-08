import 'jasmine';
import * as SAT from 'sat';
import { Entity } from 'nova_ecs/entity';
import { SingletonComponent, World } from 'nova_ecs/world';
import RBush from 'rbush';
import {
    CollisionHitterComponent,
    CollisionVulnerabilityComponent,
    CollisionEvent,
} from './collision_interaction';
import {
    CollisionSystem,
    CaptureCollisionMovementSystem,
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
import { MovementState, MovementStateComponent, MovementPhysicsComponent, MovementSystem, MovementType } from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { ProjectileComponent } from './projectile_data';
import { UpdateHurtboxHullSystem } from './collisions_plugin';
import { sweptHullTime } from './swept_collision';
import { ProjectileCollisionSystem } from './projectile_plugin';
import { ProjectileDataComponent } from './projectile_data';
import { getDefaultProjectileWeaponData, getDefaultBeamWeaponData } from 'novadatainterface/WeaponData';
import { BeamPlugin, BeamDataComponent, BeamStateComponent } from './beam_plugin';
import { FireSubs, OwnerComponent, WeaponConstructors } from './fire_weapon_plugin';
import { CreateTime } from './create_time';
import { DamagedEvent } from './death_plugin';
import { System } from 'nova_ecs/system';
import { EmitNow, UUID } from 'nova_ecs/arg_types';
import { createDraft, finishDraft } from 'immer';
import { init as initNovaWasm } from '../../../nova_wasm';

describe('translational swept hull geometry', () => {
    const zero = { x: 0, y: 0 };
    const motion = { x: 20, y: 0 };
    const circle = (x: number, y: number, r = 1) => new SAT.Circle(new SAT.Vector(x, y), r);
    const box = (x: number, y: number) => new SAT.Box(new SAT.Vector(x, y), 2, 2).toPolygon();

    it('finds exact polygon, circle and mixed contacts, including swapped roles', () => {
        expect(sweptHullTime([box(10, 0)], [box(0, 0)], motion, zero)).toBeCloseTo(0.4);
        expect(sweptHullTime([circle(10, 0)], [circle(0, 0)], motion, zero)).toBeCloseTo(0.4);
        expect(sweptHullTime([circle(10, 1)], [box(0, 0)], motion, zero)).toBeCloseTo(0.45);
        expect(sweptHullTime([box(0, 0)], [circle(10, 1)], zero, motion)).toBeCloseTo(0.45);
    });

    it('handles tangencies, initial overlap, zero speed and separated parallel motion', () => {
        expect(sweptHullTime([circle(10, 2)], [circle(0, 0)], motion, zero)).toBeCloseTo(0.5);
        expect(sweptHullTime([circle(0, 0)], [circle(0, 0)], zero, zero)).toBe(0);
        expect(sweptHullTime([circle(10, 0)], [circle(0, 0)], zero, zero)).toBeUndefined();
        expect(sweptHullTime([box(10, 3)], [box(0, 0)], motion, zero)).toBeUndefined();
        expect(sweptHullTime([circle(10, 2.001)], [circle(0, 0)], motion, zero)).toBeUndefined();
        expect(sweptHullTime([circle(10, 0)], [circle(0, 0)], motion, motion)).toBeUndefined();
    });

    it('handles rotated convex geometry and composite gaps without mutating shapes', () => {
        const target = box(0, 0).setAngle(Math.PI / 4);
        const before = target.calcPoints.map(p => [p.x, p.y]);
        expect(sweptHullTime([circle(10, 1)], [target], motion, zero)).toBeDefined();
        expect(target.calcPoints.map(p => [p.x, p.y])).toEqual(before);
        expect(sweptHullTime([circle(10, 5)], [box(0, 0), box(0, 8)], motion, zero)).toBeUndefined();
    });
});

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

function movingWorld(projectile = true) {
    const world = makeWorld(new CompositeHull([
        new SAT.Circle(new SAT.Vector(), 1),
    ]), new CompositeHull([new SAT.Box(new SAT.Vector(), 4, 4).toPolygon()]));
    world.resources.set(TimeResource, { time: 100, frame: 1, delta_s: 0.1, delta_ms: 100 });
    world.addSystem(CaptureCollisionMovementSystem);
    world.addSystem(MovementSystem);
    world.addSystem(UpdateHitboxHullSystem);
    world.addSystem(UpdateHurtboxHullSystem);
    const hitter = world.entities.get('hitter')!;
    hitter.components.get(HurtboxHullComponent)!.pos = new SAT.Vector(-10, 2);
    if (projectile) hitter.addComponent(ProjectileComponent, { id: 'test' });
    hitter.addComponent(MovementStateComponent, {
        position: new Position(-10, 2), rotation: new Angle(0),
        velocity: new Vector(200, 0), accelerating: 0, turning: 0, turnBack: false,
    }).addComponent(MovementPhysicsComponent, {
        acceleration: 0, maxVelocity: Infinity, turnRate: 0,
        movementType: MovementType.INERTIAL,
    });
    return world;
}

describe('collision broad and narrow phases', () => {
    it('detects a fast projectile crossing a target between movement endpoints', () => {
        const world = movingWorld();
        const collisions: unknown[] = [];
        world.events.get(CollisionEvent).subscribe(event => collisions.push(event));
        world.step();
        expect(world.entities.get('hitter')!.components.get(MovementStateComponent)!.position.x).toBe(10);
        expect(collisions).toContain(jasmine.objectContaining({ other: 'target', initiator: true }));
    });
    it('does not sweep non-projectile hurtboxes (including beams)', () => {
        const world = movingWorld(false);
        const collisions: unknown[] = [];
        world.events.get(CollisionEvent).subscribe(event => collisions.push(event));
        world.step();
        expect(collisions).toEqual([]);
        const movement = world.entities.get('hitter')!.components.get(MovementStateComponent)!;
        movement.position = new Position(1, 2);
        movement.velocity = new Vector(0, 0);
        world.step();
        expect(collisions).toContain({ other: 'target', initiator: true });
    });

    it('does not mistake a stationary target hull offset for movement', () => {
        const world = movingWorld();
        const movement = world.entities.get('hitter')!.components.get(MovementStateComponent)!;
        movement.velocity = new Vector(0, 0);
        // Hull origin and movement origin may differ; the offset is not travel.
        world.entities.get('target')!.addComponent(MovementStateComponent, {
            ...movement, position: new Position(-20, 2),
        });
        world.addSystem(new System({
            name: 'offset-target-hull', after: [UpdateHitboxHullSystem], before: [CollisionSystem],
            args: [SingletonComponent] as const,
            step() { world.entities.get('target')!.components.get(HitboxHullComponent)!.pos.x = 0; },
        }));
        const collisions: unknown[] = [];
        world.events.get(CollisionEvent).subscribe(event => collisions.push(event));
        world.step();
        expect(collisions).toEqual([]);
    });

    it('does not retain a revoked shape-array draft in the WASM geometry cache', async () => {
        await initNovaWasm();
        const draft = createDraft([triangle().shapes[0], triangle().shapes[0]]);
        const hull = new CompositeHull(draft as unknown as CompositeHull['shapes']);
        const other = new CompositeHull([triangle().shapes[0], triangle().shapes[0]]);
        expect(hull.collides(other)).toBeTrue();
        const shapes = finishDraft(draft);
        Object.assign(hull, { shapes: [...shapes] });
        expect(() => hull.collides(other)).not.toThrow();
        expect(hull.collides(other)).toBeTrue();
    });

    it('uses relative target motion, not the target endpoint alone', () => {
        const world = movingWorld();
        const hitter = world.entities.get('hitter')!;
        const movement = hitter.components.get(MovementStateComponent)!;
        world.entities.get('target')!.addComponent(MovementStateComponent, {
            ...movement, position: new Position(0, -10), velocity: new Vector(0, 200),
        }).addComponent(MovementPhysicsComponent, hitter.components.get(MovementPhysicsComponent)!);
        const collisions: unknown[] = [];
        world.events.get(CollisionEvent).subscribe(event => collisions.push(event));
        world.step();
        expect(collisions).toContain(jasmine.objectContaining({ other: 'target', initiator: true }));
    });

    it('does not sweep across a wrap through the center of the world', () => {
        const world = movingWorld();
        const movement = world.entities.get('hitter')!.components.get(MovementStateComponent)!;
        movement.position = new Position(9995, 2);
        const collisions: unknown[] = [];
        world.events.get(CollisionEvent).subscribe(event => collisions.push(event));
        world.step();
        expect(collisions).toEqual([]);
    });

    it('does not replay old motion after a pause, teleport, or reused entity ID', () => {
        const world = movingWorld();
        world.step();
        const collisions: unknown[] = [];
        world.events.get(CollisionEvent).subscribe(event => collisions.push(event));
        const movement = world.entities.get('hitter')!.components.get(MovementStateComponent)!;
        movement.position = new Position(-10, 2);
        movement.velocity = new Vector(0, 0);
        world.resources.get(TimeResource)!.delta_s = 0;
        world.step();
        world.entities.delete('hitter');
        world.entities.set('hitter', new Entity()
            .addComponent(HurtboxHullComponent, triangle())
            .addComponent(ProjectileComponent, { id: 'replacement' })
            .addComponent(CollisionHitterComponent, { hitTypes: new Set(['unrelated']) }));
        world.step();
        expect(collisions).toEqual([]);
        expect(world.resources.get(RBushResource)!.all()).toEqual([]);
    });

    it('copies pre-movement coordinates rather than retaining revoked drafts', () => {
        const world = movingWorld();
        const movement = createDraft(world.entities.get('hitter')!.components.get(MovementStateComponent)!);
        const tree = world.resources.get(RBushResource)!;
        CaptureCollisionMovementSystem.step(tree, world.resources.get(TimeResource)!, [
            ['hitter', movement as unknown as MovementState, undefined],
        ], undefined);
        finishDraft(movement);
        world.removeSystem(CaptureCollisionMovementSystem);
        expect(() => world.step()).not.toThrow();
        expect(tree.all()).toEqual([]);
    });

    for (const ignoreNearest of [false, true]) {
        it(`resolves the earliest eligible impact once (ignore nearest: ${ignoreNearest})`, () => {
            const world = movingWorld();
            const subs = jasmine.createSpy('fireSubs').and.returnValue([]);
            world.resources.set(FireSubs, subs);
            world.addSystem(ProjectileCollisionSystem);
            const hitter = world.entities.get('hitter')!;
            hitter.addComponent(ProjectileDataComponent, getDefaultProjectileWeaponData())
                .addComponent(CreateTime, 0).addComponent(OwnerComponent, { owner: 'shooter' });
            const farHull = new CompositeHull([new SAT.Box(new SAT.Vector(), 2, 4).toPolygon()]);
            farHull.pos = new SAT.Vector(9, 0);
            // Lexically earlier ID must not beat the nearer target.
            world.entities.set('a-far', new Entity().addComponent(HitboxHullComponent, farHull)
                .addComponent(CollisionVulnerabilityComponent, { vulnerableTo: new Set(['laser']) }));
            const nearest = world.entities.get('target')!;
            world.entities.delete('target');
            world.entities.set('target', nearest);
            if (ignoreNearest) nearest.addComponent(OwnerComponent, { owner: 'shooter' });
            const damaged: string[] = [];
            world.addSystem(new System({ name: 'record-damage', events: [DamagedEvent],
                args: [UUID] as const, step(id) { damaged.push(id); } }));
            world.step();
            expect(damaged).toEqual([ignoreNearest ? 'a-far' : 'target']);
            expect(subs).toHaveBeenCalledTimes(1);
            expect(world.entities.has('hitter')).toBeFalse();
            expect(hitter.components.get(MovementStateComponent)!.position.x).toBeCloseTo(ignoreNearest ? 8 : -1);
        });
    }

    it('positions the projectile movement origin at contact when its hull is offset', () => {
        const world = movingWorld();
        world.resources.set(FireSubs, () => []);
        world.addSystem(ProjectileCollisionSystem);
        const hitter = world.entities.get('hitter')!;
        hitter.addComponent(ProjectileDataComponent, getDefaultProjectileWeaponData())
            .addComponent(CreateTime, 0).addComponent(OwnerComponent, { owner: 'shooter' });
        world.addSystem(new System({
            name: 'offset-projectile-hull', after: [UpdateHurtboxHullSystem], before: [CollisionSystem],
            args: [SingletonComponent] as const,
            step() { hitter.components.get(HurtboxHullComponent)!.pos.x += 5; },
        }));
        world.step();
        expect(world.entities.has('hitter')).toBeFalse();
        expect(hitter.components.get(MovementStateComponent)!.position.x).toBeCloseTo(-6);
    });

    it('orders different projectiles globally and skips targets removed by an earlier impact', () => {
        const world = movingWorld();
        const subs = jasmine.createSpy('fireSubs').and.returnValue([]);
        world.resources.set(FireSubs, subs);
        world.addSystem(ProjectileCollisionSystem);
        const slow = world.entities.get('hitter')!;
        slow.addComponent(ProjectileDataComponent, getDefaultProjectileWeaponData())
            .addComponent(CreateTime, 0).addComponent(OwnerComponent, { owner: 'shooter' });
        const fast = new Entity()
            .addComponent(ProjectileComponent, { id: 'fast' })
            .addComponent(ProjectileDataComponent, getDefaultProjectileWeaponData())
            .addComponent(CreateTime, 0).addComponent(OwnerComponent, { owner: 'shooter' })
            .addComponent(HurtboxHullComponent, new CompositeHull([new SAT.Circle(new SAT.Vector(), 1)]))
            .addComponent(CollisionHitterComponent, { hitTypes: new Set(['laser']) })
            .addComponent(MovementPhysicsComponent, slow.components.get(MovementPhysicsComponent)!)
            .addComponent(MovementStateComponent, {
                ...slow.components.get(MovementStateComponent)!,
                position: new Position(-10, 2), velocity: new Vector(400, 0),
            });
        world.entities.set('z-fast', fast);
        const farHull = new CompositeHull([new SAT.Box(new SAT.Vector(), 2, 4).toPolygon()]);
        farHull.pos = new SAT.Vector(8, 0);
        world.entities.set('far', new Entity().addComponent(HitboxHullComponent, farHull)
            .addComponent(CollisionVulnerabilityComponent, { vulnerableTo: new Set(['laser']) }));
        const damaged: string[] = [];
        world.addSystem(new System({ name: 'remove-damaged-target', events: [DamagedEvent],
            args: [UUID, DamagedEvent] as const,
            step(id, event) {
                damaged.push(`${event.damager}:${id}`);
                world.entities.delete(id);
            },
        }));
        world.step();
        expect(damaged).toEqual(['z-fast:target', 'hitter:far']);
        expect(subs).toHaveBeenCalledTimes(2);
        expect(world.entities.has('z-fast')).toBeFalse();
        expect(world.entities.has('hitter')).toBeFalse();
    });

    it('clears the tree even if narrowphase throws', () => {
        const world = movingWorld(false);
        const hitter = world.entities.get('hitter')!;
        hitter.components.get(MovementStateComponent)!.velocity = new Vector(0, 0);
        hitter.components.get(MovementStateComponent)!.position = new Position(1, 2);
        spyOn(hitter.components.get(HurtboxHullComponent)!, 'collides').and.throwError('narrowphase failure');
        expect(() => world.step()).toThrowError('narrowphase failure');
        expect(world.resources.get(RBushResource)!.all()).toEqual([]);
    });

    it('rejects a parallel near miss even when swept AABBs overlap', () => {
        const world = movingWorld();
        const movement = world.entities.get('hitter')!.components.get(MovementStateComponent)!;
        movement.velocity = new Vector(100, 0);
        // End near the corner but outside the circle's radius.
        movement.position = new Position(-10.9, -0.9);
        const collisions: unknown[] = [];
        world.events.get(CollisionEvent).subscribe(event => collisions.push(event));
        world.step();
        expect(collisions).toEqual([]);
    });

    it('documents existing beam double-target damage at equal clipping distance', () => {
        const world = movingWorld(false);
        world.resources.set(WeaponConstructors, new Map());
        world.resources.set(FireSubs, () => []);
        world.addPlugin(BeamPlugin);
        const beam = world.entities.get('hitter')!;
        const data = getDefaultBeamWeaponData();
        data.shotDuration = 1000;
        data.beamAnimation.length = 20;
        data.beamAnimation.width = 2;
        beam.addComponent(HurtboxHullComponent, new CompositeHull([
            new SAT.Polygon(new SAT.Vector(), [new SAT.Vector(-1, 0),
                new SAT.Vector(-1, -20), new SAT.Vector(1, -20), new SAT.Vector(1, 0)]),
        ])).addComponent(BeamDataComponent, data)
            .addComponent(BeamStateComponent, { inaccuracy: 0 })
            .addComponent(CreateTime, 1)
            .addComponent(CollisionHitterComponent, { hitTypes: new Set(['normal']) });
        const movement = beam.components.get(MovementStateComponent)!;
        movement.position = new Position(0, 0);
        movement.velocity = new Vector(0, 0);
        const targetHull = new CompositeHull([new SAT.Box(new SAT.Vector(), 2, 2).toPolygon()]);
        targetHull.pos = new SAT.Vector(-1, -10);
        const target = world.entities.get('target')!;
        target.addComponent(HitboxHullComponent, targetHull)
            .addComponent(CollisionVulnerabilityComponent, { vulnerableTo: new Set(['normal']) });
        const secondHull = new CompositeHull([new SAT.Box(new SAT.Vector(), 2, 2).toPolygon()]);
        secondHull.pos = new SAT.Vector(-1, -10);
        world.entities.set('second', new Entity().addComponent(HitboxHullComponent, secondHull)
            .addComponent(CollisionVulnerabilityComponent, { vulnerableTo: new Set(['normal']) }));
        const occludedHull = new CompositeHull([new SAT.Box(new SAT.Vector(), 2, 2).toPolygon()]);
        occludedHull.pos = new SAT.Vector(-1, -16);
        world.entities.set('occluded', new Entity().addComponent(HitboxHullComponent, occludedHull)
            .addComponent(CollisionVulnerabilityComponent, { vulnerableTo: new Set(['normal']) }));
        const damaged: string[] = [];
        world.addSystem(new System({ name: 'record-beam-damage', events: [DamagedEvent],
            args: [UUID] as const, step(id) { damaged.push(id); } }));
        world.step();
        expect(beam.components.get(BeamStateComponent)!.length).toBe(8);
        expect(damaged.sort()).toEqual(['second', 'target']);
    });

    it('does not emit reciprocal outgoing damage from a projectile hit by a persistent hitter', () => {
        const world = movingWorld(false);
        const subs = jasmine.createSpy('fireSubs').and.returnValue([]);
        world.resources.set(FireSubs, subs);
        world.addSystem(ProjectileCollisionSystem);
        const target = world.entities.get('target')!;
        target.addComponent(ProjectileDataComponent, getDefaultProjectileWeaponData())
            .addComponent(CreateTime, 0).addComponent(OwnerComponent, { owner: 'enemy' });
        const movement = world.entities.get('hitter')!.components.get(MovementStateComponent)!;
        movement.position = new Position(1, 2);
        movement.velocity = new Vector(0, 0);
        const damaged: string[] = [];
        world.addSystem(new System({ name: 'record-reciprocal-damage', events: [DamagedEvent],
            args: [UUID] as const, step(id) { damaged.push(id); } }));
        world.addSystem(new System({ name: 'persistent-hitter-damage', events: [CollisionEvent],
            args: [CollisionEvent, UUID, EmitNow] as const,
            step(event, id, emitNow) {
                if (event.initiator) emitNow(DamagedEvent, {
                    damage: getDefaultProjectileWeaponData().damage, damager: id,
                }, [event.other]);
            },
        }));
        world.step();
        expect(damaged).toEqual(['target']);
        expect(subs).not.toHaveBeenCalled();
        expect(world.entities.has('target')).toBeTrue();
        expect(world.entities.has('hitter')).toBeTrue();
    });

    it('emits one event pair even when multiple compound shapes overlap', () => {
        const world = makeWorld(new CompositeHull([
            new SAT.Circle(new SAT.Vector(), 2), new SAT.Circle(new SAT.Vector(), 3),
        ]), triangle());
        const collisions: unknown[] = [];
        world.events.get(CollisionEvent).subscribe(event => collisions.push(event));
        world.step();
        expect(collisions.length).toBe(2);
    });

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
