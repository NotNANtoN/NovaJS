import 'jasmine';
import { BehaviorSubject, Subject } from 'rxjs';
import { Entity } from 'nova_ecs/entity';
import { System } from 'nova_ecs/system';
import { World } from 'nova_ecs/world';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { EcsKeyboardEvent } from 'nova_ecs/plugins/keyboard_plugin';
import {
    MovementPhysicsComponent,
    MovementPlugin,
    MovementStateComponent,
    MovementSystem,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import {
    Communicator,
    multiplayer,
    MultiplayerData,
    Peers,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { TimePlugin, TimeResource } from 'nova_ecs/plugins/time_plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import {
    ControlEventSystem,
    ControlsResource,
    ControlsSubject,
} from './controls_plugin';
import {
    ControlPlayerShip,
    ControlStateResource,
    UpdateControlState,
} from './ship_controller_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { TargetComponent } from './target_component';

class ProfilingCommunicator implements Communicator {
    readonly uuid = 'profile-client';
    readonly peers = new Peers(new BehaviorSubject(new Set<string>()));
    readonly servers = new BehaviorSubject(new Set(['server']));
    readonly messages =
        new Subject<{ source: string; message: unknown }>();
    readonly connected = new BehaviorSubject(true);
    messageCount = 0;
    messageBytes = 0;
    maxSerializationMs = 0;

    sendMessage(message: unknown): void {
        const started = performance.now();
        const json = JSON.stringify(message);
        this.maxSerializationMs = Math.max(
            this.maxSerializationMs, performance.now() - started);
        this.messageBytes += json.length;
        this.messageCount++;
    }
}

function keyboardEvent(
    code: string,
    type: 'keydown' | 'keyup',
): KeyboardEvent {
    return {
        code,
        key: code,
        type,
        repeat: false,
        getModifierState: () => false,
        preventDefault: () => undefined,
    } as unknown as KeyboardEvent;
}

describe('movement key transition regression', () => {
    it('keeps Up -> Up+Left -> Up steps bounded and continuous', () => {
        const communicator = new ProfilingCommunicator();
        const world = new World('movement transition profile');
        world.addPlugin(multiplayer(communicator));
        world.addPlugin(TimePlugin);
        world.addPlugin(MovementPlugin);
        const time = world.resources.get(TimeResource)!;
        time.time = 0;
        time.fixedDelta_ms = 1000 / 60;

        world.resources.set(ControlsResource, new Map([
            ['ArrowUp', [{ action: 'accelerate', modifiers: [] }]],
            ['ArrowLeft', [{ action: 'turnLeft', modifiers: [] }]],
        ]));
        world.resources.set(ControlsSubject, new Subject());
        world.resources.set(ControlStateResource, new Map());
        world.addSystem(ControlEventSystem);
        world.addSystem(UpdateControlState);
        world.addSystem(ControlPlayerShip);

        const playerUuid = 'profile-player';
        world.entities.set(playerUuid, new Entity()
            .addComponent(MultiplayerData, { owner: communicator.uuid })
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(MovementPhysicsComponent, {
                maxVelocity: 200,
                turnRate: 0.8,
                acceleration: 40,
                movementType: MovementType.INERTIAL,
            })
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(20, 0),
                rotation: new Angle(Math.PI / 2),
                turning: 0,
                turnBack: false,
                accelerating: 0,
            }));

        const systems = ([...(world as any).systems] as System[]);
        const originalSteps = new Map<System, System['step']>();
        const maxSystemMs = new Map<string, number>();
        let maxQueueLength = 0;
        for (const system of systems) {
            const original = system.step;
            originalSteps.set(system, original);
            (system as any).step = (...args: unknown[]) => {
                maxQueueLength = Math.max(
                    maxQueueLength,
                    (world as any).eventQueue.length,
                );
                const started = performance.now();
                try {
                    return original(...(args as [any, any]));
                } finally {
                    maxSystemMs.set(system.name, Math.max(
                        maxSystemMs.get(system.name) ?? 0,
                        performance.now() - started,
                    ));
                }
            };
        }

        const deltaMaker = world.resources.get(DeltaResource)!;
        const originalGetDelta = deltaMaker.getDelta.bind(deltaMaker);
        let maxDeltaMs = 0;
        (deltaMaker as any).getDelta = (entity: Entity) => {
            const started = performance.now();
            try {
                return originalGetDelta(entity);
            } finally {
                maxDeltaMs = Math.max(
                    maxDeltaMs, performance.now() - started);
            }
        };

        const transitionStepMs: number[] = [];
        const positions: number[] = [];
        try {
            world.emit(EcsKeyboardEvent,
                keyboardEvent('ArrowUp', 'keydown'));
            world.step();
            for (let frame = 0; frame < 30; frame++) {
                world.step();
            }
            maxQueueLength = 0;

            for (let cycle = 0; cycle < 60; cycle++) {
                for (const event of [
                    keyboardEvent('ArrowLeft', 'keydown'),
                    keyboardEvent('ArrowLeft', 'keyup'),
                ]) {
                    world.emit(EcsKeyboardEvent, event);
                    const started = performance.now();
                    world.step();
                    transitionStepMs.push(performance.now() - started);
                    positions.push(world.entities.get(playerUuid)!.components
                        .get(MovementStateComponent)!.position.x);
                }
            }
        } finally {
            for (const [system, original] of originalSteps) {
                (system as any).step = original;
            }
            (deltaMaker as any).getDelta = originalGetDelta;
        }

        const maxTransitionStepMs = Math.max(...transitionStepMs);
        const maxSingleSystemMs = Math.max(...maxSystemMs.values());
        let maxBackwardFrame = 0;
        for (let index = 1; index < positions.length; index++) {
            maxBackwardFrame = Math.max(
                maxBackwardFrame,
                positions[index - 1] - positions[index],
            );
        }
        console.info(
            `[motion-profile] transition=${maxTransitionStepMs.toFixed(3)}ms `
            + `system=${maxSingleSystemMs.toFixed(3)}ms `
            + `delta=${maxDeltaMs.toFixed(3)}ms queue=${maxQueueLength} `
            + `messages=${communicator.messageCount} `
            + `bytes=${communicator.messageBytes} `
            + `stringify=${communicator.maxSerializationMs.toFixed(3)}ms`,
        );

        expect(maxQueueLength).toBeLessThanOrEqual(4);
        expect(maxTransitionStepMs).toBeLessThan(20);
        expect(maxSingleSystemMs).toBeLessThan(10);
        expect(maxDeltaMs).toBeLessThan(10);
        expect(communicator.maxSerializationMs).toBeLessThan(10);
        expect(maxBackwardFrame).toBeLessThan(0.001);
        expect(positions.at(-1)!).toBeGreaterThan(positions[0]);
        expect(maxSystemMs.has(MovementSystem.name)).toBeTrue();
    });
});
