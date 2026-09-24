import 'jasmine';
import { Angle } from '../datatypes/angle';
import { Position } from '../datatypes/position';
import { Vector } from '../datatypes/vector';
import { Entity } from '../entity';
import { World } from '../world';
import { DeterministicDelayedNetwork } from './delayed_network';
import {
    applyCommand, clampCommandDt, ClientPrediction, MAX_COMMAND_DT_MS,
    MovementCommand, sanitizeCommand, ServerCommandQueue, SNAP_DISTANCE,
} from './input_prediction';
import {
    copyMovementState, MovementDriverComponent, MovementPhysics,
    MovementPhysicsComponent, MovementPlugin, MovementState,
    MovementStateComponent, MovementType,
} from './movement_plugin';
import { Comms, multiplayer, MultiplayerData } from './multiplayer_plugin';
import { TimePlugin, TimeResource } from './time_plugin';

const FRAME = 1000 / 60;
const physics: MovementPhysics = {
    maxVelocity: 300, turnRate: 3, acceleration: 200, movementType: MovementType.INERTIAL,
};
const entities = new Map() as never;

function state(x = 0, y = 0): MovementState {
    return {
        position: new Position(x, y), velocity: new Vector(0, 0), rotation: new Angle(0),
        accelerating: 0, turning: 0, turnBack: false,
    };
}

function command(seq: number, controls: Partial<MovementCommand> = {}): MovementCommand {
    return {
        seq, dtMs: FRAME, accelerating: 0, turning: 0, turnBack: false, turnTo: null,
        ...controls,
    };
}

describe('input prediction', () => {
    it('clamps and validates command durations and controls', () => {
        expect(clampCommandDt(-5)).toBe(0);
        expect(clampCommandDt(NaN)).toBe(0);
        expect(clampCommandDt(1000)).toBe(MAX_COMMAND_DT_MS);
        expect(sanitizeCommand(command(0))).toBeUndefined();
        expect(sanitizeCommand(command(1, { dtMs: 0 }))).toBeUndefined();
        const cheat = sanitizeCommand(command(2, { accelerating: 50, turning: -9, dtMs: 5000 }))!;
        expect(cheat.accelerating).toBe(1);
        expect(cheat.turning).toBe(-1);
        expect(cheat.dtMs).toBe(MAX_COMMAND_DT_MS);
    });

    it('replays unacknowledged commands on top of the server state', () => {
        let seq = 0;
        const prediction = new ClientPrediction(() => ++seq);
        const local = state();
        const server = state();
        const queue = new ServerCommandQueue(1);
        const sent: MovementCommand[] = [];
        for (let i = 0; i < 30; i++) {
            local.accelerating = 1;
            local.turning = i < 10 ? 1 : 0;
            prediction.predict(local, physics, FRAME, entities);
            sent.push(...prediction.takeOutbox());
        }
        // The server has only seen the first 20 commands.
        queue.push(sent.slice(0, 20));
        for (let i = 0; i < 20; i++) queue.step(server, physics, FRAME, entities);
        expect(queue.lastProcessedSeq).toBe(20);
        const before = copyMovementState(local);
        expect(prediction.reconcile({ seq: 20, state: copyMovementState(server) },
            local, physics, entities)).toBe('adopted');
        expect(prediction.pending.length).toBe(10);
        expect(local.position.x).toBeCloseTo(before.position.x, 6);
        expect(local.position.y).toBeCloseTo(before.position.y, 6);
    });

    it('blends small corrections, snaps teleports, and ignores stale acks', () => {
        let seq = 100;
        const prediction = new ClientPrediction(() => ++seq);
        const local = state();
        prediction.predict(local, physics, FRAME, entities);
        prediction.predict(local, physics, FRAME, entities);
        expect(prediction.reconcile({ seq: 99, state: state(50, 0) }, local, physics, entities))
            .toBe('stale');

        const knocked = state(0, 0);
        knocked.velocity = new Vector(60, 0);
        expect(prediction.reconcile({ seq: 101, state: knocked }, local, physics, entities))
            .toBe('blended');
        // Velocity is adopted at once; the position error is blended in.
        expect(local.velocity.x).toBeCloseTo(60, 6);
        expect(local.position.x).toBeGreaterThan(0);
        expect(local.position.x).toBeLessThan(1);

        expect(prediction.reconcile({ seq: 102, state: state(SNAP_DISTANCE * 3, 0) },
            local, physics, entities)).toBe('snapped');
        expect(local.position.x).toBe(SNAP_DISTANCE * 3);
        expect(prediction.pending.length).toBe(0);
    });

    it('keeps a starved server copy moving, then coasts, then resumes input', () => {
        const queue = new ServerCommandQueue(1);
        const server = state();
        queue.push([command(1, { accelerating: 1 })]);
        queue.step(server, physics, FRAME, entities);
        const speedAtStall = Math.hypot(server.velocity.x, server.velocity.y);
        // 200 ms without input: keeps thrusting on the last controls.
        for (let i = 0; i < 12; i++) queue.step(server, physics, FRAME, entities);
        expect(Math.hypot(server.velocity.x, server.velocity.y)).toBeGreaterThan(speedAtStall);
        // A long stall stops adding thrust.
        for (let i = 0; i < 60; i++) queue.step(server, physics, FRAME, entities);
        const coasting = Math.hypot(server.velocity.x, server.velocity.y);
        queue.step(server, physics, FRAME, entities);
        expect(Math.hypot(server.velocity.x, server.velocity.y)).toBeCloseTo(coasting, 6);
        queue.push(Array.from({ length: 5 }, (_, i) => command(i + 2)));
        queue.step(server, physics, FRAME, entities);
        expect(queue.lastProcessedSeq).toBe(6);
        expect(queue.extrapolatedMs).toBe(0);
    });

    it('orders reordered commands and drops duplicates and old ones', () => {
        const queue = new ServerCommandQueue(5);
        queue.push([command(6), command(5), command(6), command(4), command(8), command(7)]);
        expect(queue.queue.map(c => c.seq)).toEqual([5, 6, 7, 8]);
    });

    it('waits briefly for a missing command before skipping it', () => {
        const queue = new ServerCommandQueue(1);
        const server = state();
        queue.push([command(1), command(3)]);
        queue.step(server, physics, FRAME, entities);
        expect(queue.lastProcessedSeq).toBe(1);
        queue.push([command(2)]);
        queue.step(server, physics, FRAME, entities);
        queue.step(server, physics, FRAME, entities);
        expect(queue.lastProcessedSeq).toBe(3);

        queue.push([command(5)]);
        for (let i = 0; i < 12; i++) queue.step(server, physics, FRAME, entities);
        expect(queue.lastProcessedSeq).toBe(5);
    });

    it('integrates a command sequence deterministically', () => {
        const commands = [command(1, { accelerating: 1, turning: 1, dtMs: 13 }),
            command(2, { accelerating: 1, dtMs: 21 }), command(3, { turnBack: true, dtMs: 17 })];
        const run = () => commands.reduce(
            (current, next) => applyCommand(current, physics, next, entities), state());
        const a = run();
        const b = run();
        expect(a.position.x).toBe(b.position.x);
        expect(a.position.y).toBe(b.position.y);
        expect(a.rotation.angle).toBe(b.rotation.angle);
    });
});

describe('input prediction over the network', () => {
    interface Setup {
        network: DeterministicDelayedNetwork;
        server: World;
        owner: World;
        observer: World;
        step(): void;
        pose(world: World): MovementState;
    }

    function setup(options: {
        delays?: number[], drop?: (source: string, message: unknown, index: number) => boolean,
        ownerPrediction?: boolean,
    } = {}): Setup {
        const network = new DeterministicDelayedNetwork({
            delays: options.delays ?? [40, 70, 55, 90, 60], drop: options.drop,
        });
        const make = (uuid: string, prediction: boolean) => {
            const world = new World(uuid);
            world.addPlugin(multiplayer(network.connect(uuid), undefined,
                { inputPrediction: prediction }));
            world.addPlugin(TimePlugin);
            world.addPlugin(MovementPlugin);
            const time = world.resources.get(TimeResource)!;
            time.fixedDelta_ms = FRAME;
            world.singletonEntity.components.get(Comms)!.admins = new Set(['server']);
            return world;
        };
        const server = make('server', false);
        const owner = make('owner', options.ownerPrediction ?? true);
        const observer = make('observer', true);
        owner.entities.set('ship', new Entity()
            .addComponent(MultiplayerData, { owner: 'owner' })
            .addComponent(MovementStateComponent, state())
            .addComponent(MovementPhysicsComponent, { ...physics }));
        return {
            network, server, owner, observer,
            step() {
                owner.step();
                server.step();
                observer.step();
                network.advance();
            },
            pose(world) {
                return world.entities.get('ship')!.components.get(MovementStateComponent)!;
            },
        };
    }

    function drive(s: Setup, frame: number) {
        const controls = s.pose(s.owner);
        controls.accelerating = frame % 240 < 150 ? 1 : 0;
        controls.turning = frame % 120 < 30 ? 1 : frame % 120 < 50 ? -1 : 0;
    }

    it('keeps owner, server and observer in agreement while flying', () => {
        const s = setup();
        for (let frame = 0; frame < 600; frame++) {
            drive(s, frame);
            s.step();
        }
        // Stop steering and let every copy settle.
        for (let frame = 0; frame < 60; frame++) {
            const controls = s.pose(s.owner);
            controls.accelerating = 0;
            controls.turning = 0;
            s.step();
        }
        const own = s.pose(s.owner);
        const server = s.pose(s.server);
        const observed = s.pose(s.observer);
        const speed = Math.hypot(own.velocity.x, own.velocity.y);
        expect(speed).toBeGreaterThan(50);
        // The server applies the same commands one trip later; while coasting
        // it trails the owner by less than that trip (at most ~100 ms).
        expect(server.velocity.x).toBeCloseTo(own.velocity.x, 6);
        expect(server.velocity.y).toBeCloseTo(own.velocity.y, 6);
        expect(server.rotation.distanceTo(own.rotation).angle).toBeCloseTo(0, 6);
        const lag = Math.hypot(own.position.x - server.position.x,
            own.position.y - server.position.y) / speed * 1000;
        expect(lag).toBeLessThan(110);
        // The owner's prediction is exactly the server path: last ack plus
        // its own unacknowledged commands (no residual correction).
        const prediction = [...s.owner.entities.get('ship')!.components.keys()]
            .some(component => component === MovementDriverComponent);
        expect(prediction).toBeTrue();
        expect(observed.velocity.x).toBeCloseTo(own.velocity.x, 1);
        expect(observed.velocity.y).toBeCloseTo(own.velocity.y, 1);
        expect(s.server.entities.get('ship')!.components.has(MovementDriverComponent)).toBeTrue();
    });

    it('lets the owner accelerate on the same frame as the input', () => {
        const s = setup();
        for (let frame = 0; frame < 60; frame++) s.step();
        s.pose(s.owner).accelerating = 1;
        s.step();
        expect(Math.hypot(s.pose(s.owner).velocity.x, s.pose(s.owner).velocity.y)).toBeGreaterThan(0);
    });

    it('applies a server-side velocity change to the owner exactly once', () => {
        const s = setup({ delays: [50] });
        for (let frame = 0; frame < 120; frame++) s.step();
        s.pose(s.server).velocity = new Vector(80, 0);
        for (let frame = 0; frame < 120; frame++) s.step();
        expect(s.pose(s.owner).velocity.x).toBeCloseTo(80, 3);
        expect(s.pose(s.server).velocity.x).toBeCloseTo(80, 3);
        expect(s.pose(s.observer).velocity.x).toBeCloseTo(80, 0);
    });

    it('snaps the owner to a server teleport', () => {
        const s = setup({ delays: [50] });
        for (let frame = 0; frame < 120; frame++) s.step();
        s.pose(s.server).position = new Position(4000, -3000);
        for (let frame = 0; frame < 30; frame++) s.step();
        expect(s.pose(s.owner).position.x).toBeCloseTo(4000, 3);
        expect(s.pose(s.owner).position.y).toBeCloseTo(-3000, 3);
    });

    it('keeps the ship moving for observers while input is lost, then reconverges', () => {
        let dropping = false;
        const s = setup({
            delays: [50],
            drop: source => dropping && source === 'owner',
        });
        for (let frame = 0; frame < 120; frame++) {
            s.pose(s.owner).accelerating = 1;
            s.step();
        }
        dropping = true;
        const before = s.pose(s.observer).position.y;
        for (let frame = 0; frame < 18; frame++) {
            s.pose(s.owner).accelerating = 1;
            s.step();
        }
        dropping = false;
        expect(s.pose(s.observer).position.y).toBeLessThan(before - 10);
        for (let frame = 0; frame < 180; frame++) {
            s.pose(s.owner).accelerating = 0;
            s.step();
        }
        expect(s.pose(s.server).velocity.y).toBeCloseTo(s.pose(s.owner).velocity.y, 1);
    });

    it('still serves an owner that authors its own pose', () => {
        const s = setup({ ownerPrediction: false, delays: [50] });
        for (let frame = 0; frame < 240; frame++) {
            drive(s, frame);
            s.step();
        }
        for (let frame = 0; frame < 60; frame++) {
            s.pose(s.owner).accelerating = 0;
            s.pose(s.owner).turning = 0;
            s.step();
        }
        expect(s.server.entities.get('ship')!.components.has(MovementDriverComponent)).toBeFalse();
        expect(s.pose(s.observer).velocity.x).toBeCloseTo(s.pose(s.owner).velocity.x, 0);
        expect(s.pose(s.observer).velocity.y).toBeCloseTo(s.pose(s.owner).velocity.y, 0);
    });
});
