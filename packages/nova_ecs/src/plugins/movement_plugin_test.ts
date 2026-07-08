import 'jasmine';
import { v4 } from 'uuid';
import { Angle } from '../datatypes/angle.js';
import { Position } from '../datatypes/position.js';
import { Vector, VectorLike } from '../datatypes/vector.js';
import { Entity } from '../entity.js';
import { System } from '../system.js';
import { World } from '../world.js';
import { approachVec, MovementPhysicsComponent, MovementPlugin, MovementStateComponent, MovementSystem, MovementType, teleport } from './movement_plugin.js';
import { DeltaResource } from './delta_plugin.js';
import { TimePlugin } from './time_plugin.js';

describe('Movement Plugin', () => {
    let world: World;
    let clock: jasmine.Clock;
    beforeEach(() => {
        clock = jasmine.clock();
        clock.install();
        clock.mockDate(new Date(100));

        world = new World();
        world.addPlugin(TimePlugin);
        world.addPlugin(MovementPlugin);
    });

    afterEach(() => {
        clock.uninstall();
    });

    it('updates position', () => {
        const velocity = new Vector(10, -7);

        world.entities.set(v4(), new Entity()
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                accelerating: 0,
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity,
            })
            .addComponent(MovementPhysicsComponent, {
                acceleration: 100,
                maxVelocity: 500,
                turnRate: 50,
                movementType: MovementType.INERTIAL,
            }));


        const positions: Position[] = [];
        const reportSystem = new System({
            name: 'ReportSystem',
            args: [MovementStateComponent],
            step: (state) => {
                // Copy the position since it's a draft
                // TODO: Why doe TypeScript think it's a vector and not a position?
                positions.push(state.position.scale(1) as Position);
            },
            after: [MovementSystem],
        });
        world.addSystem(reportSystem);

        world.step();
        clock.tick(1000);
        world.step();

        expect(positions).toEqual([
            Position.fromVectorLike(velocity.scale(0)),
            Position.fromVectorLike(velocity.scale(1)),
        ]);
    });

    it('updates velocity', () => {
        const rotation = new Angle(Math.PI / 4);
        world.entities.set(v4(), new Entity()
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                accelerating: 1,
                rotation: rotation,
                turnBack: false,
                turning: 0,
                velocity: new Vector(0, 0),
            })
            .addComponent(MovementPhysicsComponent, {
                acceleration: 100,
                maxVelocity: 500,
                turnRate: 50,
                movementType: MovementType.INERTIAL,
            }));


        const velocities: Vector[] = [];
        const reportSystem = new System({
            name: 'ReportSystem',
            args: [MovementStateComponent],
            step: (state) => {
                // Copy the position since it's a draft
                velocities.push(state.velocity.scale(1));
            },
            after: [MovementSystem],
        });
        world.addSystem(reportSystem);

        world.step();
        clock.tick(1000);
        world.step();

        // Inverted clock angles. See ../dataTypes/angle.ts.
        expect(velocities).toEqual([
            new Vector(0, 0),
            new Vector(100 * Math.sin(rotation.angle), -100 * Math.cos(rotation.angle))
        ]);
    });

    it('updates rotation', () => {
        world.entities.set(v4(), new Entity()
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                accelerating: 1,
                rotation: new Angle(0),
                turnBack: false,
                turning: 1,
                velocity: new Vector(0, 0),
            })
            .addComponent(MovementPhysicsComponent, {
                acceleration: 100,
                maxVelocity: 500,
                turnRate: 50,
                movementType: MovementType.INERTIAL,
            }));


        const rotations: number[] = [];
        const reportSystem = new System({
            name: 'ReportSystem',
            args: [MovementStateComponent],
            step: (state) => {
                // Copy the position since it's a draft
                rotations.push(state.rotation.angle);
            },
            after: [MovementSystem],
        });
        world.addSystem(reportSystem);

        world.step();
        clock.tick(1000);
        world.step();

        expect(rotations).toEqual([
            0,
            new Angle(50).angle,
        ]);
    });

    it('sends a movement delta when an entity teleports', () => {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource');
        }

        const entity = new Entity()
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                accelerating: 0,
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(10, 0),
            });

        // First delta establishes the baseline state.
        expect(deltaMaker.getDelta(entity)?.componentStates
            ?.has(MovementStateComponent.name)).toBe(true);

        // getDelta redrafts components, so re-get the state each time.
        const state = () => entity.components.get(MovementStateComponent)!;

        // Predictable drift does not produce a delta.
        state().position = new Position(10, 0);
        expect(deltaMaker.getDelta(entity)).toBeUndefined();

        // A teleport does.
        teleport(state(), new Position(-500, 300));
        const delta = deltaMaker.getDelta(entity);
        const sent = delta?.componentDeltas?.get(MovementStateComponent.name) as
            { position: { x: number, y: number } } | undefined;
        expect(sent?.position).toEqual(jasmine.objectContaining({ x: -500, y: 300 }));

        // And the next unchanged frame is quiet again.
        state().position = new Position(-490, 300);
        expect(deltaMaker.getDelta(entity)).toBeUndefined();
    });

    it('approachVec approaches a target vector', () => {
        // 3,4,5 triangle for nice numbers
        const current = new Vector(1, 1);
        const target = current.add(new Vector(3, 4).scale(4));

        const res = approachVec(target, current, 5 * 2);
        const expected = current.add(new Vector(3, 4).scale(2));
        expect(res.x).toBeCloseTo(expected.x);
        expect(res.y).toBeCloseTo(expected.y);
    });
});
