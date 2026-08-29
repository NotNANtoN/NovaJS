import 'jasmine';
import { v4 } from 'uuid';
import { Angle } from '../datatypes/angle';
import { Position } from '../datatypes/position';
import { Vector, VectorLike } from '../datatypes/vector';
import { Entity } from '../entity';
import { System } from '../system';
import { World } from '../world';
import {
    applyMovementStateDelta,
    approachVec,
    MOVEMENT_ANGLE_QUANTUM,
    MOVEMENT_POSITION_QUANTUM,
    MOVEMENT_VELOCITY_QUANTUM,
    MovementPhysicsComponent,
    MovementPlugin,
    MovementStateComponent,
    MovementSystem,
    MovementType,
    quantizedMovementDelta,
    quantizeMovementState,
    RemoteMovementPresentationComponent,
    RemoteMovementPresentationSystem,
    sampleRemoteMovement,
} from './movement_plugin';
import { MAX_WALL_CLOCK_DELTA_MS, TimePlugin } from './time_plugin';

describe('Movement Plugin', () => {
    let world: World;
    let clock: jasmine.Clock;
    beforeEach(() => {
        clock = jasmine.clock();
        clock.install();
        clock.mockDate(new Date(100));
        spyOn(performance, 'now').and.returnValues(100, 100, 1100);

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
            Position.fromVectorLike(velocity.scale(
                MAX_WALL_CLOCK_DELTA_MS / 1000)),
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
            new Vector(
                100 * Math.sin(rotation.angle),
                -100 * Math.cos(rotation.angle),
            ).scale(MAX_WALL_CLOCK_DELTA_MS / 1000),
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
            new Angle(50 * MAX_WALL_CLOCK_DELTA_MS / 1000).angle,
        ]);
    });

    it('does not simulate a remote entity before presentation sampling', () => {
        const uuid = v4();
        world.entities.set(uuid, new Entity()
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                accelerating: 0,
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(10, 0),
            })
            .addComponent(MovementPhysicsComponent, {
                acceleration: 100,
                maxVelocity: 500,
                turnRate: 50,
                movementType: MovementType.INERTIAL,
            })
            .addComponent(RemoteMovementPresentationComponent, {
                snapshots: [{
                    serverTime: 0,
                    state: {
                        position: new Position(100, 0),
                        accelerating: 0,
                        rotation: new Angle(0),
                        turnBack: false,
                        turning: 0,
                        velocity: new Vector(0, 0),
                    },
                }],
            }));

        const positions: number[] = [];
        world.addSystem(new System({
            name: 'RemoteMovementBeforePresentationReport',
            args: [MovementStateComponent] as const,
            after: [MovementSystem],
            before: [RemoteMovementPresentationSystem],
            step: state => positions.push(state.position.x),
        }));

        world.step();

        expect(positions).toEqual([0]);
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

    it('quantizes movement below a visible pixel and prediction step', () => {
        const quantized = quantizeMovementState({
            position: new Position(10.12, -5.13),
            velocity: new Vector(19.96, -20.04),
            rotation: new Angle(0.12349),
            turning: 0,
            turnBack: false,
            accelerating: 0,
            targetSpeed: 99.96,
        });

        expect(MOVEMENT_POSITION_QUANTUM).toBe(0.25);
        expect(MOVEMENT_VELOCITY_QUANTUM).toBe(0.1);
        expect(MOVEMENT_ANGLE_QUANTUM).toBe(0.001);
        expect(quantized.position).toEqual(new Position(10, -5.25));
        expect(quantized.velocity).toEqual(new Vector(20, -20));
        expect(quantized.rotation.angle).toBeCloseTo(0.123, 6);
        expect(quantized.targetSpeed).toBe(100);
    });

    it('suppresses movement fields that stay in the same quantized bucket', () => {
        const before = {
            position: new Position(10.01, 20.01),
            velocity: new Vector(30.01, 40.01),
            rotation: new Angle(0.1001),
            turning: 0,
            turnBack: false,
            accelerating: 0,
        };
        const withinBucket = {
            ...before,
            position: new Position(10.02, 20.02),
            velocity: new Vector(30.02, 40.02),
            rotation: new Angle(0.1002),
        };
        expect(quantizedMovementDelta(before, withinBucket)).toBeUndefined();

        const crossedPositionBucket = {
            ...withinBucket,
            position: new Position(10.2, 20.02),
        };
        const delta = quantizedMovementDelta(before, crossedPositionBucket);
        expect(delta?.position).toEqual(new Position(10.25, 20));
        expect(delta?.velocity).toBeUndefined();
        expect(delta?.rotation).toBeUndefined();
    });

    it('interpolates remote movement across the system wrap', () => {
        const physics = {
            maxVelocity: 500,
            turnRate: 1,
            acceleration: 1,
            movementType: MovementType.INERTIAL,
        };
        const pose = (x: number) => ({
            position: new Position(x, 0),
            velocity: new Vector(0, 0),
            rotation: new Angle(0),
            turning: 0,
            turnBack: false,
            accelerating: 0,
        });
        const sampled = sampleRemoteMovement({
            snapshots: [
                { serverTime: 0, state: pose(9900) },
                { serverTime: 100, state: pose(-9900) },
            ],
        }, 50, physics, world.entities);
        expect(sampled).toBeDefined();
        expect(Math.abs(sampled!.position.x)).toBeGreaterThan(9000);
    });

    it('can clear an optional movement value with a partial delta', () => {
        const state = {
            position: new Position(0, 0),
            velocity: new Vector(0, 0),
            rotation: new Angle(0),
            turning: 0,
            turnBack: false,
            accelerating: 0,
            targetSpeed: 100,
        };

        applyMovementStateDelta(state, { targetSpeed: null });

        expect(state.targetSpeed).toBeUndefined();
    });
});
